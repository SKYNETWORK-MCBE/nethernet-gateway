import { logger, NetherNetGateway } from '../src';
import { createMinecraftClientTokenVerifier } from '../src/minecraft';
import { getConnInfo, serve } from '../src/node';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
  verifyClientToken: createMinecraftClientTokenVerifier(),
  getConnInfo,
});

gateway.use(logger());

gateway.on('info', ({ url, client }) => {
  console.log('Server information requested:', url, client);
});

gateway.on('join', ({ status, networkId, identity }) => {
  console.log('Join:', status, networkId, identity.gamertag);
});

gateway.on('requestError', (event) => {
  console.error(event);
});

serve({ fetch: gateway.fetch, port: 19133 }, ({ port }) => {
  console.log(`NetherNet Gateway listening on port ${port}`);
});
