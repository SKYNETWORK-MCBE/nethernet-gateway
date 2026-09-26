import { logger, NetherNetGateway } from './src';
import { createMinecraftClientTokenVerifier } from './src/minecraft';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
  verifyClientToken: createMinecraftClientTokenVerifier(),
});

gateway.use(logger());

gateway.on('info', ({ url }) => {
  console.log('Server information requested:', url);
});

gateway.on('join', ({ networkId, identity, untrustedIdentity }) => {
  console.log('Join attempt:', networkId, identity?.gamertag ?? untrustedIdentity.gamertag);
});

gateway.on('requestError', (event) => {
  console.error(event);
});

await gateway.listen(19133);
console.log('NetherNet Gateway listening on port 19133');
