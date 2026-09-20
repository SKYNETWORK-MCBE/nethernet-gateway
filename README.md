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

Client identity verification is optional by default.

```ts
import { NetherNetGateway } from 'nethernet-gateway';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
});

await gateway.listen(8080);
```

Only the NetherNet signaling endpoints are proxied. Other paths return `404`.

## Middleware

Calling `use()` with a middleware applies it to every request before routing. It can return its own response or call `next()` to wrap the downstream response. Every middleware receives its own request clone and parsed URL, so reading the body or changing `context.url` does not affect later middleware. Pass a replacement `Request` to `next()` to change the downstream request and routing.

```ts
gateway.use(async (context, next) => {
  if (context.url.pathname === '/health') return new Response('OK');

  const response = await next();
  console.log(context.request.method, response.status);
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

gateway.use('info', async (_context, next) => {
  const response = await next(); // retrieve the upstream server info
  const info = (await response.json()) as NetherNetServerInfo;

  return Response.json({
    ...info,
    name: 'Modified Server Name',
  });
});
```

### Verify client identity

`verifyClientToken` must verify the `GameServerToken` issuer before returning an identity. The gateway then verifies that the token's `cpk` signed the SDP fingerprints. `context.identity` is exposed only after both checks succeed.

Install `jose` in the application that performs JWT verification:

```sh
pnpm add jose
```

```ts
import { createRemoteJWKSet, jwtVerify, type JWK } from 'jose';
import { NetherNetGateway } from 'nethernet-gateway';

const minecraftKeys = createRemoteJWKSet(new URL(process.env.MINECRAFT_JWKS_URL!));

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',

  async verifyClientToken(token) {
    const { payload } = await jwtVerify(token, minecraftKeys, {
      issuer: process.env.MINECRAFT_TOKEN_ISSUER,
      audience: process.env.MINECRAFT_TOKEN_AUDIENCE,
    });

    if (typeof payload.xid !== 'string' || !isJwk(payload.cpk)) {
      throw new Error('Invalid GameServerToken');
    }

    return {
      xuid: payload.xid,
      cpk: payload.cpk,
      claims: payload,
    };
  },
});

function isJwk(value: unknown): value is JWK {
  return typeof value === 'object' && value !== null && 'kty' in value;
}
```

The JWKS URL, issuer, audience, and claim validation depend on the authentication service you trust. They are intentionally not guessed by this package.

When a verifier is configured but an offer has no identity assertion, the join remains anonymous. An assertion that is present but invalid is always rejected with `401`.

### Authorize joins by XUID

Use a join middleware to reject known XUIDs at signaling time. This uses the verified `context.identity` from the previous example:

```ts
const bannedXuids = new Set(['2533274790000000']);

gateway.use('join', (context, next) => {
  if (context.identity && bannedXuids.has(context.identity.xuid)) {
    return new Response('Banned', { status: 403 });
  }

  return next();
});
```

Treat this as an early rejection only; repeat the authoritative BAN check after game login using the authenticated player identity. NetherNet signaling is only involved in the initial SDP exchange ([Mojang guide, §3](https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/#3-architecture-overview)).

### Require client identity

Set `requireClientIdentity` to reject offers without an identity assertion. This option requires `verifyClientToken`.

```ts
const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
  verifyClientToken,
  requireClientIdentity: true,
});
```

### Rewrite ICE candidates

A gateway that does not share an address with the game server leaves both sides advertising ICE candidates the other cannot reach. `rewriteAnswerCandidates` keeps only the routable candidates in the upstream answer, drops host candidates once a NAT-traversing candidate exists, blanks the related address, and readdresses the survivors to the gateway. `stripOfferCandidates` removes the client's candidates from the offer; pass the replacement request to `next()` to send it upstream.

```ts
import { NetherNetGateway, rewriteAnswerCandidates, stripOfferCandidates } from 'nethernet-gateway';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
});

gateway.use('join', async (context, next) => {
  const offer = stripOfferCandidates(context.offer);
  const response = await next(new Request(context.request, { method: 'POST', body: offer }));
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

Authentication failures and other expected `4xx` responses are not emitted.

## Security

- Put the public signaling endpoint behind HTTPS. TLS termination is outside this package.
- A decoded JWT is not an authenticated identity. Verify its signature and expected claims in `verifyClientToken`.
- Invalid token or fingerprint signatures are rejected before the offer reaches the upstream server.
- Request bodies larger than 1 MiB are rejected with `413` before middleware runs. SDP offers must also be valid UTF-8.
- To hide the global IP address of the backend, override ICE candidate. (See the "Rewrite ICE candidates" section.)

## Acknowledgements

- [mojang/bedrock-protocol-docs](https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/)
- [df-mc/go-nethernet](https://github.com/df-mc/go-nethernet)
- [df-mc/nethernet-spec](https://github.com/df-mc/nethernet-spec)
