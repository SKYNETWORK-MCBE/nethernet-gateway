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

### Rate limit requests

Every join request that reaches BDS may reserve a UDP port. An attacker can exhaust the configured
port range by repeatedly requesting offers, so apply `rateLimit` to the join middleware stack. The
limiter uses a sliding window and can apply multiple limits to each request.

```ts
import { NetherNetGateway, rateLimit, type JoinContext } from 'nethernet-gateway';

const gateway = new NetherNetGateway({ upstream: 'http://127.0.0.1:19132' });
gateway.use(
  'join',
  rateLimit({
    windowMs: 60_000,
    rules: [rateLimit.ip(3), rateLimit.global(50)],
  }),
);
```

The built-in `ip` key limits each direct TCP peer independently, while `global` protects the BDS
port pool from the total request rate. A request must have capacity under every applicable rule
before it reaches BDS.

Use a key function to limit by any other value. Returning `undefined` skips that rule for the
request. For example, a join middleware can limit verified players by XUID:

```ts
rateLimit<JoinContext>({
  windowMs: 60_000,
  rules: [rateLimit.custom<JoinContext>(2, (c) => c.identity?.xuid)],
});
```

The helpers return ordinary rule objects, so helpers and manually defined rules can be combined.

When the gateway runs behind a trusted proxy, use a key function that reads forwarding data the
proxy overwrites instead of the built-in `ip` key. Client-supplied forwarding headers are not
trusted by default:

```ts
rateLimit({
  windowMs: 60_000,
  rules: [
    {
      key: (c) => c.req.headers.get('x-real-ip') ?? c.remoteAddress ?? '',
      limit: 3,
    },
  ],
});
```

The proxy must remove or overwrite any client-supplied `X-Real-IP` value. Counters are stored in
memory and are not shared between gateway processes.

This middleware limits how quickly requests reach BDS. It cannot release ports that BDS has already
reserved, so the BDS UDP port range and reservation timeout still need to be configured safely.

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

### Verify client identity

`verifyClientToken` must verify the `GameServerToken` issuer before returning an identity. The gateway then verifies that the token's `cpk` signed the SDP fingerprints. `c.identity` is exposed only after both checks succeed.

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

Use a join middleware to reject known XUIDs at signaling time. This uses the verified `c.identity` from the previous example:

```ts
const bannedXuids = new Set(['2533274790000000']);

gateway.use('join', (c, next) => {
  if (c.identity && bannedXuids.has(c.identity.xuid)) {
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
- A decoded JWT is not an authenticated identity. Verify its signature and expected claims in `verifyClientToken`.
- Invalid token or fingerprint signatures are rejected before the offer reaches the upstream server.
- Request bodies larger than 1 MiB are rejected with `413` before middleware runs. SDP offers must also be valid UTF-8.
- To hide the global IP address of the backend, override ICE candidate. (See the "Rewrite ICE candidates" section.)

## Acknowledgements

- [mojang/bedrock-protocol-docs](https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/)
- [df-mc/go-nethernet](https://github.com/df-mc/go-nethernet)
- [df-mc/nethernet-spec](https://github.com/df-mc/nethernet-spec)
