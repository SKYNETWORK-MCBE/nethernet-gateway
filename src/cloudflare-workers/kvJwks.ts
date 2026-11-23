import type { JwksStore } from '../minecraft/verifier';
import type { GatewayContext, GatewayEnv } from '../types';

/** The part of a Workers KV binding (`KVNamespace`) the store calls. */
export interface JwksKVNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

export interface KvJwksOptions {
  /** The KV key the JWKS is stored under. Defaults to `jwks`. */
  key?: string;
  /**
   * Seconds until the stored JWKS expires, so that a key the service has withdrawn does not stay
   * trusted. Defaults to one day. KV requires at least 60.
   */
  expirationTtl?: number;
}

const DEFAULT_KEY = 'jwks';
const DEFAULT_EXPIRATION_TTL = 24 * 60 * 60;

/**
 * Keeps the JWKS of `createMinecraftClientTokenVerifier` in Workers KV, so a new isolate reads the
 * keys from KV instead of fetching them. Pass the result as its `jwks` option.
 */
export function kvJwks<E extends GatewayEnv = GatewayEnv>(
  namespace: (c: GatewayContext<E>) => JwksKVNamespace,
  options: KvJwksOptions = {},
): JwksStore<E> {
  const { key = DEFAULT_KEY, expirationTtl = DEFAULT_EXPIRATION_TTL } = options;
  return {
    get: async (c) => (await namespace(c).get(key, 'json')) as Awaited<ReturnType<Get<E>>>,
    set: async (c, jwks) => {
      await namespace(c).put(key, JSON.stringify(jwks), { expirationTtl });
    },
  };
}

type Get<E extends GatewayEnv> = NonNullable<JwksStore<E>['get']>;
