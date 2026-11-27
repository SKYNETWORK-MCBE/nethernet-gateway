// wrangler dev examples/cloudflare-workers.ts
import { logger, NetherNetGateway } from '../src';
import { getConnInfo, type RateLimiter, rateLimitBinding } from '../src/cloudflare-workers';
import { createMinecraftClientTokenVerifier } from '../src/minecraft';

interface Env {
  /** A URL Cloudflare can reach, such as a Cloudflare Tunnel hostname in front of BDS. */
  UPSTREAM: string;
  /** [[ratelimits]] bindings in the Wrangler configuration, such as `simple = { limit = 3, period = 60 }`. */
  JOIN_IP_LIMITER: RateLimiter;
  JOIN_XUID_LIMITER: RateLimiter;
}

const gateway = new NetherNetGateway<{ Bindings: Env }>({
  upstream: (c) => c.env.UPSTREAM,
  verifyClientToken: createMinecraftClientTokenVerifier(),
  getConnInfo,
});

gateway.use(logger());
gateway.use(
  'join',
  rateLimitBinding({
    rules: [
      { limiter: (c) => c.env.JOIN_IP_LIMITER, key: 'ip' },
      { limiter: (c) => c.env.JOIN_XUID_LIMITER, key: (c) => c.identity.xuid },
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
