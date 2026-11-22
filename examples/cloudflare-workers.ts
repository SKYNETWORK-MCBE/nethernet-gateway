// wrangler dev examples/cloudflare-workers.ts
import { logger, NetherNetGateway } from '../src';
import { getConnInfo, type RateLimitBinding, rateLimitBinding } from '../src/cloudflare-workers';
import { createMinecraftClientTokenVerifier } from '../src/minecraft';

interface Env {
  /** A URL Cloudflare can reach, such as a Cloudflare Tunnel hostname in front of BDS. */
  UPSTREAM: string;
  /** [[ratelimits]] bindings in the Wrangler configuration, such as `simple = { limit = 3, period = 60 }`. */
  JOIN_IP_LIMITER: RateLimitBinding;
  JOIN_XUID_LIMITER: RateLimitBinding;
}

const gateway = new NetherNetGateway({
  upstream: (c) => (c.env as Env).UPSTREAM,
  verifyClientToken: createMinecraftClientTokenVerifier(),
  getConnInfo,
});

gateway.use(logger());
gateway.use(
  'join',
  rateLimitBinding({
    rules: [
      { limiter: (c) => (c.env as Env).JOIN_IP_LIMITER, key: 'ip' },
      { limiter: (c) => (c.env as Env).JOIN_XUID_LIMITER, key: (c) => c.identity.xuid },
    ],
    retryAfter: 60,
  }),
);

gateway.on('join', ({ status, networkId, identity }) => {
  console.log('Join:', status, networkId, identity.gamertag);
});

gateway.on('info', ({ url, client }) => {
  console.log('Server information requested:', url, client);
});

gateway.on('requestError', (event) => {
  console.error(event);
});

export default gateway;
