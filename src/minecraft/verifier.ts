import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  jwksCache,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
  type JWKSCacheInput,
  type JWTVerifyGetKey,
} from 'jose';
import * as v from 'valibot';
import { decodeBase64 } from '../base64';
import type {
  Awaitable,
  GatewayContext,
  GatewayEnv,
  NetherNetIdentity,
  VerifyClientToken,
} from '../types';
import { minecraftIdentityClaimEntries, normalizeMinecraftIdentityClaims } from './claims';

const MINECRAFT_ISSUER = 'https://authorization.franchise.minecraft-services.net/';
const MINECRAFT_AUDIENCE = 'api://auth-minecraft-services/multiplayer';
export type { JSONWebKeySet };

/** The JWKS endpoint of Minecraft's authorization service. */
export const MINECRAFT_JWKS_URL = `${MINECRAFT_ISSUER}.well-known/keys`;

const minecraftClaimsSchema = v.object({
  ...minecraftIdentityClaimEntries,
  cpk: v.unknown(),
  exp: v.number(),
  iat: v.number(),
});

const clientPublicJwkSchema = v.looseObject({
  kty: v.literal('EC'),
  crv: v.literal('P-384'),
  x: v.string(),
  y: v.string(),
});

/** A store of your own for the trusted JWKS, such as a key-value binding. */
export interface JwksStore<E extends GatewayEnv = GatewayEnv> {
  /**
   * Returns the stored keys, or nothing when none are stored. It runs for every token. A failure,
   * or a value that is not a JWKS, counts as nothing stored.
   */
  get?(c: GatewayContext<E>): Awaitable<JSONWebKeySet | null | undefined>;
  /**
   * Receives the keys each time the verifier fetches `jwksUrl`. It runs under
   * `c.executionCtx.waitUntil` when the runtime has one, without delaying the verification, and a
   * failure is ignored.
   */
  set?(c: GatewayContext<E>, jwks: JSONWebKeySet): Awaitable<void>;
}

export interface MinecraftClientTokenVerifierOptions<E extends GatewayEnv = GatewayEnv> {
  /** Override only when using a compatible trusted authentication service. */
  readonly issuer?: string;
  /** Override only when using a compatible trusted authentication service. */
  readonly audience?: string | string[];
  /** Override the trusted JWKS endpoint. The URL is never taken from the client assertion. */
  readonly jwksUrl?: string | URL;
  /**
   * Keeps the trusted keys in a store of your own. The verifier uses the keys `get` returns and
   * fetches `jwksUrl` only when there are none or they lack the token's key, then passes what it
   * fetched to `set`.
   */
  readonly jwks?: JwksStore<E>;
}

/**
 * Creates a verifier for GameServerToken JWTs issued by Minecraft's authorization service.
 * The JWKS is fetched lazily on the first assertion and cached in memory by `jose`. Pass `jwks` to
 * also keep it in a store of your own.
 */
export function createMinecraftClientTokenVerifier<E extends GatewayEnv = GatewayEnv>(
  options: MinecraftClientTokenVerifierOptions<E> = {},
): VerifyClientToken {
  const verification = {
    issuer: options.issuer ?? MINECRAFT_ISSUER,
    audience: options.audience ?? MINECRAFT_AUDIENCE,
    algorithms: ['RS256'],
  };
  const store = options.jwks;
  // jose records each fetch here, which is how a fetch is noticed.
  const fetched: JWKSCacheInput = {};
  const fetchedKeys = createRemoteJWKSet(new URL(options.jwksUrl ?? MINECRAFT_JWKS_URL), {
    [jwksCache]: fetched,
  });

  const verifyWithFetchedKeys = async (token: string, c: GatewayContext<E>) => {
    const before = fetched.uat;
    try {
      return await jwtVerify(token, fetchedKeys, verification);
    } finally {
      const { jwks } = fetched;
      if (store?.set && jwks && fetched.uat !== before) {
        // Storing the keys must neither delay nor fail the verification.
        const stored = Promise.resolve()
          .then(() => store.set?.(c, jwks))
          .catch(() => {});
        c.executionCtx?.waitUntil(stored);
      }
    }
  };

  const storedKeys = async (c: GatewayContext<E>): Promise<JWTVerifyGetKey | undefined> => {
    try {
      const jwks = await store?.get?.(c);
      return jwks ? createLocalJWKSet(jwks) : undefined;
    } catch {
      // An unreadable store must not block joins while the keys can still be fetched.
      return undefined;
    }
  };

  const verify = async (token: string, c: GatewayContext<E>) => {
    const keys = await storedKeys(c);
    if (!keys) return verifyWithFetchedKeys(token, c);
    try {
      return await jwtVerify(token, keys, verification);
    } catch (error) {
      // The stored keys predate a key rotation; any other failure is final.
      if (error instanceof errors.JWKSNoMatchingKey) return verifyWithFetchedKeys(token, c);
      throw error;
    }
  };

  return async (token, c): Promise<NetherNetIdentity> => {
    const { payload } = await verify(token, c as GatewayContext<E>);
    const result = v.safeParse(minecraftClaimsSchema, payload);
    if (!result.success) throw new Error('Invalid GameServerToken claims');

    return {
      ...normalizeMinecraftIdentityClaims(result.output),
      cpk: await parseClientPublicKey(result.output.cpk),
      claims: payload,
    };
  };
}

async function parseClientPublicKey(value: unknown): Promise<JWK> {
  if (typeof value === 'string') {
    let jwk: JsonWebKey;
    try {
      const key = await crypto.subtle.importKey(
        'spki',
        decodeBase64(value),
        { name: 'ECDSA', namedCurve: 'P-384' },
        true,
        ['verify'],
      );
      jwk = await crypto.subtle.exportKey('jwk', key);
    } catch {
      throw new Error('Invalid GameServerToken client public key');
    }
    const { kty, crv, x, y } = jwk;
    return validateClientPublicKey({ kty, crv, x, y });
  }
  return validateClientPublicKey(value);
}

function validateClientPublicKey(value: unknown): JWK {
  const result = v.safeParse(clientPublicJwkSchema, value);
  if (!result.success) throw new Error('Invalid GameServerToken client public key');
  return result.output;
}
