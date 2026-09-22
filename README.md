# nethernet-gateway

A middleware-first proxy for Minecraft NetherNet HTTP signaling.

`nethernet-gateway` handles the two NetherNet signaling operations and delegates HTTP forwarding to [`httpxy`](https://github.com/unjs/httpxy):

- `GET /v1/join` — server information
- `POST /v1/join/{networkId}` — SDP offer and answer exchange

## Installation

```sh
pnpm add nethernet-gateway
```

## Proxy a NetherNet server

Every join offer must include a structurally valid client identity assertion. Cryptographic verification against a trusted token issuer is opt-in.

```ts
import { NetherNetGateway } from 'nethernet-gateway';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
});

await gateway.listen(8080);
```

Only the NetherNet signaling endpoints are proxied. Other paths return `404`.

### Choose an upstream dynamically

Pass a function to `upstream` to route multiple public hostnames through one gateway.

```ts
const upstreams = new Map([
  ['survival.example.com', 'http://localhost:19132'],
  ['creative.example.com', 'http://localhost:19133'],
]);

const gateway = new NetherNetGateway({
  upstream: (c) => upstreams.get(c.url.hostname) ?? 'http://localhost:19132',
});
```

The function runs after request middleware calls `next()`, immediately before the request is proxied. If middleware passes a replacement `Request` to `next()`, the function receives the replacement request and URL. It is not called when middleware returns an early response.

## Middleware

Calling `use()` with a middleware applies it to every request before routing. It can return its own response or call `next()` to wrap the downstream response. Every middleware receives its own request clone and parsed URL, so reading the body or changing `c.url` does not affect later middleware. Changes to `c.req.headers` are carried forward when `next()` is called. Pass a replacement `Request` to `next()` to change the downstream method, URL, or body and routing.

```ts
gateway.use(async (c, next) => {
  if (c.url.pathname === '/health') return new Response('OK');

  const response = await next();
  console.log(c.req.method, response.status);
  return response;
});
```

Server information and join attempts also have separate middleware stacks. A join middleware can pass a replacement request to `next()` to change the offer that reaches the upstream server. The gateway then parses the Network ID and offer again and repeats identity verification before running later join middleware.

### Change server information

```ts
import { NetherNetGateway, type NetherNetServerInfo } from 'nethernet-gateway';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
});

gateway.use('info', async (_c, next) => {
  const response = await next(); // retrieve the upstream server info
  const info = (await response.json()) as NetherNetServerInfo;

  return Response.json({
    ...info,
    name: 'Modified Server Name',
  });
});
```

### Read untrusted client identity

Every join offer must contain a structurally valid Minecraft identity token. The gateway decodes its XUID and PlayFab ID without requiring a verifier. These values are supplied by the client and have not been authenticated, so use them only for diagnostics, display, or other non-security-sensitive purposes.

```ts
gateway.use('join', (c, next) => {
  console.log(c.untrustedIdentity.xuid);
  console.log(c.untrustedIdentity.playFabId);
  console.log(c.untrustedIdentity.gamertag);
  return next();
});
```

Missing or malformed identity assertions are rejected with `401`. Structural validation covers the SDP identity envelope, compact JWT shape, and the `xid`, `mid`, and `xname` claims. It does not validate the JWT signature, issuer, audience, timestamps, or public key. Never use `untrustedIdentity` for bans, allowlists, permissions, or other authorization decisions.

Without `verifyClientToken`, `c.identity` remains undefined and the structurally valid offer is forwarded using only `untrustedIdentity`.

### Verify client identity

`verifyClientToken` authenticates the `GameServerToken` and returns a normalized `NetherNetIdentity`. The gateway trusts that return value, then uses its `cpk` to verify the signature over the SDP fingerprints. `c.identity` is exposed only after both steps succeed. The built-in verifier trusts Minecraft's current authorization service and fetches its JWKS lazily when the first assertion arrives.

```ts
import { NetherNetGateway } from 'nethernet-gateway';
import { createMinecraftClientTokenVerifier } from 'nethernet-gateway/minecraft';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
  verifyClientToken: createMinecraftClientTokenVerifier(),
});
```

The verifier requires `exp` and `iat`, validates Minecraft's issuer, audience, RS256 signature, expiration and any not-before timestamp, identity claims, and client public key. It maps `xid` to `xuid`, `mid` to `playFabId`, and `xname` to `gamertag`, and accepts both observed `cpk` formats: a JWK object and a Base64-encoded DER SubjectPublicKeyInfo value.

To trust another compatible authentication service or apply additional policy, provide your own `verifyClientToken` callback. The callback is responsible for validating the token and returning a complete `NetherNetIdentity` containing `xuid`, `playFabId`, `gamertag`, `cpk`, and `claims`; the gateway does not validate the callback's return shape. Tokens must still carry the `xid`, `mid`, and `xname` claims required for `untrustedIdentity`.

When a verifier is configured, its JWT verification and the SDP fingerprint binding must also succeed. Failures are rejected with `401`.

### Authorize joins by XUID

Use a join middleware to reject known XUIDs at signaling time. This uses the verified `c.identity` from the previous example:

```ts
const bannedXuids = new Set(['0000000000000000']);

gateway.use('join', (c, next) => {
  if (c.identity && bannedXuids.has(c.identity.xuid)) {
    return new Response('Banned', { status: 403 });
  }

  return next();
});
```

Treat this as an early rejection only; repeat the authoritative BAN check after game login using the authenticated player identity. NetherNet signaling is only involved in the initial SDP exchange ([Mojang guide, §3](https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/#3-architecture-overview)).

### Rewrite ICE candidates

A gateway that does not share an address with the game server leaves both sides advertising ICE candidates the other cannot reach. `rewriteAnswerCandidates` keeps only the routable candidates in the upstream answer, drops host candidates once a NAT-traversing candidate exists, blanks the related address, and readdresses the survivors to the gateway. `stripOfferCandidates` removes the client's candidates from the offer; pass the replacement request to `next()` to send it upstream.

```ts
import { NetherNetGateway, rewriteAnswerCandidates, stripOfferCandidates } from 'nethernet-gateway';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
});

gateway.use('join', async (c, next) => {
  const offer = stripOfferCandidates(c.offer);
  const response = await next(new Request(c.req, { method: 'POST', body: offer }));
  const answer = rewriteAnswerCandidates(await response.text(), '203.0.113.10');

  return new Response(answer, response);
});
```

Candidates are readdressed only when the second argument is a non-empty address; pass `''` to filter without rewriting. When no candidate survives, the answer is returned unchanged so the connection can still complete. Pass `false` as the third argument to drop the candidates instead.

## Use an existing Node server

Bind `handleRequest` to the gateway when passing it to `createServer`.

```ts
import { createServer } from 'node:http';
import { NetherNetGateway } from 'nethernet-gateway';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
});

createServer(gateway.handleRequest.bind(gateway)).listen(8080);
```

## Observe request errors

Unexpected request, middleware, upstream, and response failures are emitted for logging and metrics.

```ts
gateway.on('requestError', ({ source, error, method, url }) => {
  console.error(source, method, url, error);
});
```

`url` is consistently reported as the request path and query string, without the origin.

Authentication failures and other expected `4xx` responses are not emitted.

## Log requests

Register `logger()` once to log every request.

```ts
import { logger } from 'nethernet-gateway';

gateway.use(logger());
// --> POST /v1/join/9876543210123456789
// <-- POST /v1/join/9876543210123456789 200 12ms
```

Response status codes are colored by category. Set `NO_COLOR` to disable ANSI colors. Pass a print function to send the lines to another logger:

```ts
gateway.use(logger((line) => appLogger.info(line)));
```

## Security

- Put the public signaling endpoint behind HTTPS. TLS termination is outside this package.
- `untrustedIdentity` is decoded client input, not an authenticated identity. Never use it for authorization.
- When `verifyClientToken` is configured, invalid token or fingerprint signatures are rejected before the offer reaches the upstream server.
- Request bodies larger than 1 MiB are rejected with `413` before middleware runs. SDP offers must also be valid UTF-8.
- To hide the global IP address of the backend, override ICE candidate. (See the "Rewrite ICE candidates" section.)

## Acknowledgements

- [mojang/bedrock-protocol-docs](https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/)
- [df-mc/go-nethernet](https://github.com/df-mc/go-nethernet)
- [df-mc/nethernet-spec](https://github.com/df-mc/nethernet-spec)
