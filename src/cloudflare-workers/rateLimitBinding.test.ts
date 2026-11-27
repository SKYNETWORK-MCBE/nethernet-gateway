import { describe, expect, it } from 'vite-plus/test';
import { NetherNetGateway } from '../gateway';
import type { GatewayContext } from '../types';
import { getConnInfo, type RateLimiter, rateLimitBinding } from '.';

class FakeBinding implements RateLimiter {
  readonly keys: string[] = [];
  constructor(private readonly allowed = Number.POSITIVE_INFINITY) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(key);
    return { success: this.keys.filter((seen) => seen === key).length <= this.allowed };
  }
}

function context(remoteAddress = '192.0.2.1'): GatewayContext {
  const req = new Request('http://localhost/v1/join');
  return { req, url: new URL(req.url), remoteAddress, env: undefined, executionCtx: undefined };
}

const ok = async () => new Response(null, { status: 204 });

describe('rateLimitBinding', () => {
  it('counts each rule with its resolved key', async () => {
    const ip = new FakeBinding();
    const global = new FakeBinding();
    const custom = new FakeBinding();
    const middleware = rateLimitBinding({
      rules: [
        { limiter: () => ip, key: 'ip' },
        { limiter: () => global, key: 'global' },
        { limiter: () => custom, key: (c) => c.url.pathname },
      ],
    });

    expect((await middleware(context('2001:db8:1:2::1'), ok)).status).toBe(204);
    expect((await middleware(context('::ffff:192.0.2.1'), ok)).status).toBe(204);

    expect(ip.keys).toEqual(['ipv6:2001:db8:1:2', '192.0.2.1']);
    expect(global.keys).toEqual(['global', 'global']);
    expect(custom.keys).toEqual(['/v1/join', '/v1/join']);
  });

  it('rejects at the first rule without capacity and skips the rest', async () => {
    const first = new FakeBinding(1);
    const second = new FakeBinding();
    let downstream = 0;
    const middleware = rateLimitBinding({
      rules: [
        { limiter: () => first, key: 'ip' },
        { limiter: () => second, key: 'global' },
      ],
      retryAfter: 60,
    });
    const next = async () => {
      downstream++;
      return new Response(null, { status: 204 });
    };

    expect((await middleware(context(), next)).status).toBe(204);
    const blocked = await middleware(context(), next);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    expect(downstream).toBe(1);
    expect(second.keys).toHaveLength(1);
  });

  it('omits Retry-After without retryAfter and skips rules whose key is undefined', async () => {
    const binding = new FakeBinding(0);
    const skipped = new FakeBinding(0);
    const middleware = rateLimitBinding({
      rules: [
        { limiter: () => skipped, key: () => undefined },
        { limiter: () => binding, key: 'global' },
      ],
    });

    const blocked = await middleware(context(), ok);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.has('retry-after')).toBe(false);
    expect(skipped.keys).toEqual([]);
  });

  it('fails before counting when an ip rule has no address', async () => {
    const counted = new FakeBinding();
    const middleware = rateLimitBinding({
      rules: [
        { limiter: () => counted, key: 'global' },
        { limiter: () => new FakeBinding(), key: 'ip' },
      ],
    });

    await expect(middleware({ ...context(), remoteAddress: undefined }, ok)).rejects.toThrow(
      /getConnInfo/u,
    );
    expect(counted.keys).toEqual([]);
  });

  it.each([
    [{ rules: [] }, 'rules'],
    [{ rules: [null] }, 'rules[0]'],
    [{ rules: [{ limiter: 'binding', key: 'ip' }] }, 'limiter'],
    [{ rules: [{ limiter: () => new FakeBinding(), key: 'unknown' }] }, 'key'],
    [{ rules: [{ limiter: () => new FakeBinding(), key: 'ip' }], retryAfter: 1.5 }, 'retryAfter'],
  ])('rejects invalid options %#', (options, name) => {
    expect(() => rateLimitBinding(options as never)).toThrow(name);
  });

  it('reads the binding from the Workers env through the gateway', async () => {
    interface Env {
      JOIN_LIMITER: RateLimiter;
    }
    const env: Env = { JOIN_LIMITER: new FakeBinding(1) };
    const gateway = new NetherNetGateway<{ Bindings: Env }>({
      upstream: 'http://127.0.0.1:1',
      getConnInfo,
    });
    // The rule's context, and so c.env, is typed from the gateway the middleware is passed to.
    gateway.use(rateLimitBinding({ rules: [{ limiter: (c) => c.env.JOIN_LIMITER, key: 'ip' }] }));
    gateway.use(() => new Response('OK'));
    const request = () =>
      new Request('https://gateway.example/v1/join', {
        headers: { 'cf-connecting-ip': '198.51.100.7' },
      });

    expect((await gateway.fetch(request(), env)).status).toBe(200);
    expect((await gateway.fetch(request(), env)).status).toBe(429);
    expect((env.JOIN_LIMITER as FakeBinding).keys).toEqual(['198.51.100.7', '198.51.100.7']);
  });
});
