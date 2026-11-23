import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
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

export interface MinecraftClientTokenVerifierOptions<E extends GatewayEnv = GatewayEnv> {
  /** Override only when using a compatible trusted authentication service. */
  readonly issuer?: string;
  /** Override only when using a compatible trusted authentication service. */
  readonly audience?: string | string[];
  /** Override the trusted JWKS endpoint. The URL is never taken from the client assertion. */
  readonly jwksUrl?: string | URL;
  /**
   * Supplies the trusted keys in place of fetching `jwksUrl`, for example a JWKS that a scheduled
   * job stores in a key-value binding. A function runs for every token and receives the request
   * context; returning `undefined` or `null` falls back to fetching `jwksUrl`. A token signed by a key that
   * is not in the supplied set is rejected without fetching.
   */
  readonly jwks?:
    | JSONWebKeySet
    | ((c: GatewayContext<E>) => Awaitable<JSONWebKeySet | null | undefined>);
}

/**
 * Creates a verifier for GameServerToken JWTs issued by Minecraft's authorization service.
 * The JWKS is fetched lazily on the first assertion and cached by `jose`, unless `jwks` supplies it.
 */
export function createMinecraftClientTokenVerifier<E extends GatewayEnv = GatewayEnv>(
  options: MinecraftClientTokenVerifierOptions<E> = {},
): VerifyClientToken {
  const issuer = options.issuer ?? MINECRAFT_ISSUER;
  const audience = options.audience ?? MINECRAFT_AUDIENCE;
  const remoteKeys = createRemoteJWKSet(new URL(options.jwksUrl ?? MINECRAFT_JWKS_URL));
  const { jwks } = options;
  // Reuse the imported keys while the same JWKS object is supplied.
  const localKeys = new WeakMap<JSONWebKeySet, JWTVerifyGetKey>();
  const keysFor = async (c: GatewayContext): Promise<JWTVerifyGetKey> => {
    const supplied = typeof jwks === 'function' ? await jwks(c as GatewayContext<E>) : jwks;
    if (!supplied) return remoteKeys;
    let keys = localKeys.get(supplied);
    if (!keys) localKeys.set(supplied, (keys = createLocalJWKSet(supplied)));
    return keys;
  };

  return async (token, c): Promise<NetherNetIdentity> => {
    const { payload } = await jwtVerify(token, await keysFor(c), {
      issuer,
      audience,
      algorithms: ['RS256'],
    });
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
