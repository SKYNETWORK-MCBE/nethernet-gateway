// wrangler dev examples/cloudflare-workers.ts
import { logger, NetherNetGateway } from '../src';
import { getConnInfo } from '../src/cloudflare-workers';
import { createMinecraftClientTokenVerifier } from '../src/minecraft';

interface Env {
  /** A URL Cloudflare can reach, such as a Cloudflare Tunnel hostname in front of BDS. */
  UPSTREAM: string;
}

const gateway = new NetherNetGateway({
  upstream: (c) => (c.env as Env).UPSTREAM,
  verifyClientToken: createMinecraftClientTokenVerifier(),
  getConnInfo,
});

gateway.use(logger());

gateway.on('join', ({ status, networkId, identity }) => {
  console.log('Join:', status, networkId, identity.gamertag);
});

gateway.on('info', ({ url, client }) => {
  console.log('Server information requested:', url, client);
});

gateway.on('requestError', (event) => {
  console.error(event);
});

// The in-memory rateLimit is per isolate on Workers. Back a rateLimit.custom rule with Durable
// Objects or the Rate Limiting binding to limit joins across the whole deployment.

export default gateway;
