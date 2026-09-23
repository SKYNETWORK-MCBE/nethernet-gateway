import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { NetherNetGateway } from '../gateway';
import { createTestServers } from '../test-server';
import type { GatewayContext } from '../types';
import { rateLimit, type RateLimitOptions } from './rateLimit';

const { serve, closeAll } = createTestServers();

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAll();
});

function context(remoteAddress = '192.0.2.1'): GatewayContext {
  const req = new Request('http://localhost/test');
  return { req, url: new URL(req.url), remoteAddress };
}

describe('rateLimit', () => {
  it('blocks requests over the limit without calling downstream', async () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      rules: [rateLimit.ip(2)],
    });
    let calls = 0;
    const next = async () => {
      calls += 1;
      return new Response('OK');
    };

    const first = await middleware(context(), next);
    const second = await middleware(context(), next);
    const blocked = await middleware(context(), next);

    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-remaining')).toBe('1');
    expect(first.headers.has('retry-after')).toBe(false);
    expect(second.headers.get('ratelimit-remaining')).toBe('0');
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toBe('Too Many Requests');
    expect(blocked.headers.get('ratelimit-limit')).toBe('2');
    expect(blocked.headers.get('ratelimit-remaining')).toBe('0');
    expect(blocked.headers.get('retry-after')).toBe('60');
    expect(calls).toBe(2);
  });

  it('starts a new counter after the window expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const middleware = rateLimit({
      windowMs: 2_000,
      rules: [rateLimit.ip(1)],
    });
    const next = async () => new Response(null, { status: 204 });

    expect((await middleware(context(), next)).status).toBe(204);
    expect((await middleware(context(), next)).status).toBe(429);

    now.mockReturnValue(3_000);
    const reset = await middleware(context(), next);
    expect(reset.status).toBe(204);
    expect(reset.headers.get('ratelimit-remaining')).toBe('0');
  });

  it('reports the next available slot rather than a full quota reset', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const middleware = rateLimit({
      windowMs: 60_000,
      rules: [rateLimit.ip(2)],
    });
    const next = async () => new Response('OK');

    expect((await middleware(context(), next)).headers.get('ratelimit-reset')).toBe('60');
    now.mockReturnValue(2_000);
    const second = await middleware(context(), next);
    expect(second.headers.get('ratelimit-remaining')).toBe('0');
    expect(second.headers.get('ratelimit-reset')).toBe('59');
    const blocked = await middleware(context(), next);
    expect(blocked.headers.get('retry-after')).toBe('59');

    now.mockReturnValue(61_000);
    const renewed = await middleware(context(), next);
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get('ratelimit-remaining')).toBe('0');
    expect(renewed.headers.get('ratelimit-reset')).toBe('1');
  });

  it('does not allow a fixed-window burst at a boundary', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const middleware = rateLimit({
      windowMs: 2_000,
      rules: [rateLimit.ip(2)],
    });
    const next = async () => new Response('OK');

    expect((await middleware(context(), next)).status).toBe(200);
    now.mockReturnValue(2_999);
    expect((await middleware(context(), next)).status).toBe(200);
    expect((await middleware(context(), next)).status).toBe(429);

    now.mockReturnValue(3_000);
    expect((await middleware(context(), next)).status).toBe(200);
    expect((await middleware(context(), next)).status).toBe(429);
  });

  it('keeps separate counters for direct peer addresses', async () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      rules: [rateLimit.ip(1)],
    });
    const next = async () => new Response('OK');

    expect((await middleware(context('192.0.2.1'), next)).status).toBe(200);
    expect((await middleware(context('192.0.2.2'), next)).status).toBe(200);
    expect((await middleware(context('192.0.2.1'), next)).status).toBe(429);
  });

  it('shares an IPv6 counter within a /64 but not across /64s', async () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      rules: [rateLimit.ip(1)],
    });
    const next = async () => new Response('OK');

    expect((await middleware(context('2001:db8:1:2::1'), next)).status).toBe(200);
    expect((await middleware(context('2001:0DB8:0001:0002:abcd::1'), next)).status).toBe(429);
    expect((await middleware(context('2001:db8:1:3::1'), next)).status).toBe(200);
  });

  it('uses the IPv4 counter for IPv4-mapped IPv6 addresses', async () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      rules: [rateLimit.ip(1)],
    });
    const next = async () => new Response('OK');

    expect((await middleware(context('192.0.2.1'), next)).status).toBe(200);
    expect((await middleware(context('::ffff:192.0.2.1'), next)).status).toBe(429);
    expect((await middleware(context('::ffff:c000:201'), next)).status).toBe(429);
    expect((await middleware(context('192.0.2.2'), next)).status).toBe(200);
  });

  it('applies a global limit across peer addresses', async () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      rules: [rateLimit.global(2)],
    });
    const next = async () => new Response('OK');

    expect((await middleware(context('192.0.2.1'), next)).status).toBe(200);
    expect((await middleware(context('192.0.2.2'), next)).status).toBe(200);
    expect((await middleware(context('192.0.2.3'), next)).status).toBe(429);
  });

  it('counts only requests accepted by both limits', async () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      rules: [rateLimit.ip(1), rateLimit.global(2)],
    });
    const next = async () => new Response('OK');

    expect((await middleware(context('192.0.2.1'), next)).status).toBe(200);
    expect((await middleware(context('192.0.2.1'), next)).status).toBe(429);
    expect((await middleware(context('192.0.2.2'), next)).status).toBe(200);
    expect((await middleware(context('192.0.2.3'), next)).status).toBe(429);
  });

  it('supports asynchronous custom keys', async () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      rules: [rateLimit.custom(1, async (c) => c.req.headers.get('x-client-id') ?? 'anonymous')],
    });
    const next = async () => new Response('OK');
    const first = context('192.0.2.1');
    first.req.headers.set('x-client-id', 'player');
    const second = context('192.0.2.2');
    second.req.headers.set('x-client-id', 'player');

    expect((await middleware(first, next)).status).toBe(200);
    expect((await middleware(second, next)).status).toBe(429);
  });

  it('skips a custom rule when its key is undefined', async () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      rules: [{ key: (c) => c.req.headers.get('x-client-id') ?? undefined, limit: 1 }],
    });
    const next = async () => new Response('OK');

    const first = await middleware(context(), next);
    const second = await middleware(context(), next);

    expect(first.status).toBe(200);
    expect(first.headers.has('ratelimit-limit')).toBe(false);
    expect(second.status).toBe(200);
  });

  it.each([
    [{ windowMs: 0, rules: [{ key: 'ip', limit: 1 }] }, 'windowMs'],
    [{ windowMs: Number.POSITIVE_INFINITY, rules: [{ key: 'ip', limit: 1 }] }, 'windowMs'],
    [{ windowMs: 1_000, rules: [] }, 'rules'],
    [{ windowMs: 1_000, rules: [{ key: 'ip', limit: 0 }] }, 'limit'],
    [{ windowMs: 1_000, rules: [{ key: 'unknown', limit: 1 }] }, 'key'],
  ])('rejects invalid options %#', (options, name) => {
    expect(() => rateLimit(options as RateLimitOptions)).toThrow(name);
  });

  it('uses the gateway connection address by default', async () => {
    const gateway = new NetherNetGateway({ upstream: 'http://127.0.0.1:1' });
    gateway.use(
      rateLimit({
        windowMs: 60_000,
        rules: [rateLimit.ip(1)],
      }),
    );
    const address = await serve(gateway.handleRequest.bind(gateway));

    expect((await fetch(`${address}/missing`)).status).toBe(404);
    expect((await fetch(`${address}/missing`)).status).toBe(429);
  });

  it('passes the gateway connection address to info and join middleware', async () => {
    const gateway = new NetherNetGateway({ upstream: 'http://127.0.0.1:1' });
    const seen: string[] = [];
    gateway.use('info', (c) => {
      seen.push(c.remoteAddress ?? 'undefined');
      return new Response('OK');
    });
    gateway.use('join', (c) => {
      seen.push(c.remoteAddress ?? 'undefined');
      return new Response('OK');
    });
    const address = await serve(gateway.handleRequest.bind(gateway));

    expect((await fetch(`${address}/v1/join`)).status).toBe(200);
    expect(
      (
        await fetch(`${address}/v1/join/network`, {
          method: 'POST',
          body: 'offer',
        })
      ).status,
    ).toBe(200);
    expect(seen).toEqual(['127.0.0.1', '127.0.0.1']);
  });
});
