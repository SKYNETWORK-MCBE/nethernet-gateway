import { logger, NetherNetGateway } from './src';
import { createMinecraftClientTokenVerifier } from './src/minecraft';

const gateway = new NetherNetGateway({
  upstream: 'http://127.0.0.1:19132',
  verifyClientToken: createMinecraftClientTokenVerifier(),
});

gateway.use(logger());

gateway.use('info', (ctx, next) => {
  // console.log(ctx);
  return next();
});

gateway.use('join', (ctx, next) => {
  // console.log(ctx);
  return next();
});

gateway.on('requestError', (event) => {
  console.error(event);
});

await gateway.listen(19133);
console.log('NetherNet Gateway listening on port 19133');
