import { describe, expect, it } from 'vite-plus/test';
import { getConnInfo as bun } from './bun';
import { getConnInfo as cloudflareWorkers } from './cloudflare-workers';
import { getConnInfo as deno } from './deno';
import { NetherNetGateway } from './gateway';

const req = new Request('http://localhost/v1/join', {
  headers: { 'cf-connecting-ip': '198.51.100.1' },
});

describe('getConnInfo adapters', () => {
  it('reads the address from each runtime', () => {
    const server = {
      requestIP: (request: Request) => (request === req ? { address: '::1' } : null),
    };
    expect(bun({ req, env: server }).remote.address).toBe('::1');
    expect(deno({ env: { remoteAddr: { hostname: '192.0.2.1', port: 1 } } }).remote.address).toBe(
      '192.0.2.1',
    );
    expect(cloudflareWorkers({ req }).remote.address).toBe('198.51.100.1');
  });

  it('returns no address when the runtime passes none', () => {
    expect(bun({ req, env: undefined }).remote.address).toBeUndefined();
    expect(bun({ req, env: { requestIP: () => null } }).remote.address).toBeUndefined();
    expect(deno({ env: undefined }).remote.address).toBeUndefined();
    expect(cloudflareWorkers({ req: new Request('http://localhost/') }).remote.address).toBe(
      undefined,
    );
  });

  it('passes the runtime arguments through the gateway', async () => {
    const gateway = new NetherNetGateway({ upstream: 'http://127.0.0.1:1', getConnInfo: deno });
    let seen: string | undefined;
    gateway.use((c) => {
      seen = c.remoteAddress;
      return new Response('OK');
    });

    await gateway.fetch(req, { remoteAddr: { hostname: '203.0.113.9' } });

    expect(seen).toBe('203.0.113.9');
  });
});
