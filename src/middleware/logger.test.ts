import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { NetherNetGateway } from '../gateway';
import { logger } from './logger';
import type { NetherNetGatewayErrorEvent } from '../types';

const servers: Server[] = [];
const originalNoColor = process.env.NO_COLOR;

beforeEach(() => {
  delete process.env.NO_COLOR;
});

afterEach(async () => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('logger', () => {
  it.each([
    [204, 32],
    [302, 36],
    [404, 33],
    [503, 31],
  ])('colors a %s response with ANSI color %s', async (status, color) => {
    const lines: string[] = [];

    await logger((line) => lines.push(line))(
      { request: new Request('http://localhost/test'), url: new URL('http://localhost/test') },
      async () => new Response(null, { status }),
    );

    expect(lines[1]).toMatch(
      new RegExp(`^<-- GET /test \\x1b\\[${color}m${status}\\x1b\\[0m \\d+ms$`, 'u'),
    );
  });

  it('disables colors when NO_COLOR is set', async () => {
    process.env.NO_COLOR = '';
    const lines: string[] = [];

    await logger((line) => lines.push(line))(
      { request: new Request('http://localhost/test'), url: new URL('http://localhost/test') },
      async () => new Response(null, { status: 204 }),
    );

    expect(lines[1]).toMatch(/^<-- GET \/test 204 \d+ms$/u);
  });

  it('logs every request without its query string', async () => {
    const lines: string[] = [];
    const gateway = new NetherNetGateway({ upstream: 'http://127.0.0.1:1' });
    gateway.use(logger((line) => lines.push(line)));
    const address = await serve(gateway.handleRequest.bind(gateway));

    const response = await fetch(`${address}/missing?secret=value`);

    expect(response.status).toBe(404);
    expect(lines[0]).toBe('--> GET /missing');
    expect(lines[1].replace('\x1b[33m404\x1b[0m', '404')).toMatch(/^<-- GET \/missing 404 \d+ms$/u);
    expect(lines.join('\n')).not.toContain('secret');
  });

  it('logs the join NetworkID', async () => {
    const upstream = await serve((_request, response) => {
      response.end('answer');
    });
    const lines: string[] = [];
    const gateway = new NetherNetGateway({ upstream });
    gateway.use(logger((line) => lines.push(line)));
    const address = await serve(gateway.handleRequest.bind(gateway));

    const response = await fetch(`${address}/v1/join/9876543210123456789?source=test`, {
      method: 'POST',
      body: 'v=0\r\n',
    });

    expect(response.status).toBe(200);
    expect(lines[0]).toBe('--> POST /v1/join/9876543210123456789');
    expect(lines[1].replace('\x1b[32m200\x1b[0m', '200')).toMatch(
      /^<-- POST \/v1\/join\/9876543210123456789 200 \d+ms$/u,
    );
  });

  it('handles print failures as middleware errors', async () => {
    const errors: NetherNetGatewayErrorEvent[] = [];
    const gateway = new NetherNetGateway({ upstream: 'http://127.0.0.1:1' });
    gateway.on('requestError', (event) => errors.push(event));
    gateway.use(
      logger(() => {
        throw new Error('print failed');
      }),
    );
    const address = await serve(gateway.handleRequest.bind(gateway));

    const response = await fetch(`${address}/missing`);

    expect(response.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(errors).toEqual([
      expect.objectContaining({ source: 'middleware', method: 'GET', url: '/missing' }),
    ]);
  });
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
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
