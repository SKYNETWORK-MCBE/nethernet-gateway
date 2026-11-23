import { describe, expect, expectTypeOf, it } from 'vite-plus/test';
import { createMinecraftClientTokenVerifier } from '../minecraft';
import type { GatewayContext, GatewayEnv } from '../types';
import { kvJwks, type JwksKVNamespace } from './kvJwks';

function fakeKV() {
  const values = new Map<string, string>();
  const puts: { key: string; options: unknown }[] = [];
  const namespace: JwksKVNamespace = {
    get: async (key) => JSON.parse(values.get(key) ?? 'null'),
    put: async (key, value, options) => {
      values.set(key, value);
      puts.push({ key, options });
    },
  };
  return { namespace, values, puts };
}

function context<E extends GatewayEnv>(env: unknown): GatewayContext<E> {
  const req = new Request('http://localhost/v1/join/1', { method: 'POST' });
  return {
    req,
    url: new URL(req.url),
    remoteAddress: undefined,
    env,
    executionCtx: undefined,
  } as GatewayContext<E>;
}

describe('kvJwks', () => {
  interface Env {
    KEYS: JwksKVNamespace;
  }
  const jwks = { keys: [{ kty: 'RSA', kid: 'a', n: 'n', e: 'AQAB' }] };

  it('stores the JWKS under the default key with a one-day expiration', async () => {
    const kv = fakeKV();
    const store = kvJwks<{ Bindings: Env }>((c) => c.env.KEYS);
    const c = context<{ Bindings: Env }>({ KEYS: kv.namespace });

    expect(await store.get?.(c)).toBeNull();
    await store.set?.(c, jwks);

    expect(kv.puts).toEqual([{ key: 'jwks', options: { expirationTtl: 86_400 } }]);
    expect(await store.get?.(c)).toEqual(jwks);
  });

  it('uses the given key and expiration', async () => {
    const kv = fakeKV();
    const store = kvJwks<{ Bindings: Env }>((c) => c.env.KEYS, {
      key: 'minecraft',
      expirationTtl: 600,
    });

    await store.set?.(context<{ Bindings: Env }>({ KEYS: kv.namespace }), jwks);

    expect(kv.puts).toEqual([{ key: 'minecraft', options: { expirationTtl: 600 } }]);
  });

  it('types c.env from the verifier it is passed to', () => {
    createMinecraftClientTokenVerifier<{ Bindings: Env }>({
      jwks: kvJwks((c) => {
        expectTypeOf(c.env).toEqualTypeOf<Env>();
        return c.env.KEYS;
      }),
    });
  });
});
