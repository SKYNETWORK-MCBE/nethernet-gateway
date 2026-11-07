// deno run --allow-net examples/deno.ts
import { logger, NetherNetGateway, rateLimit } from '../src';
import { getConnInfo } from '../src/deno';
import { createMinecraftClientTokenVerifier } from '../src/minecraft';

// Provided by the Deno runtime; declared here so the example type-checks without Deno's types.
declare const Deno: {
  serve(
    options: { port: number },
    handler: (request: Request, info: unknown) => Promise<Response>,
  ): unknown;
};

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

// Deno.serve() passes its ServeHandlerInfo as the second fetch argument.
Deno.serve({ port: 19133 }, gateway.fetch);
