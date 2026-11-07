// bun run examples/bun.ts
import { logger, NetherNetGateway, rateLimit } from '../src';
import { getConnInfo } from '../src/bun';
import { createMinecraftClientTokenVerifier } from '../src/minecraft';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
  verifyClientToken: createMinecraftClientTokenVerifier(),
  getConnInfo,
});

gateway.use(logger());
gateway.use('join', rateLimit({ windowMs: 60_000, rules: [rateLimit.ip(3)] }));

gateway.on('info', ({ url, client }) => {
  console.log('Server information requested:', url, client);
});

gateway.on('join', ({ status, networkId, identity }) => {
  console.log('Join:', status, networkId, identity.gamertag);
});

gateway.on('requestError', (event) => {
  console.error(event);
});

// Bun.serve() reads this default export and passes its Server as the second fetch argument.
export default { port: 19133, fetch: gateway.fetch };
