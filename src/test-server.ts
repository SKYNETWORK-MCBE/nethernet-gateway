import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export function createTestServers() {
  const servers: Server[] = [];

  async function serve(
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    return `http://127.0.0.1:${address.port}`;
  }

  async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return {
    servers,
    serve,
    closeServer,
    closeAll: () => Promise.all(servers.splice(0).map(closeServer)),
  };
}
