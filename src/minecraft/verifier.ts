import { createPublicKey } from 'node:crypto';
import { createRemoteJWKSet, exportJWK, jwtVerify, type JWK } from 'jose';
import * as v from 'valibot';
import type { NetherNetIdentity, VerifyClientToken } from '../types';
import { minecraftIdentityClaimEntries, normalizeMinecraftIdentityClaims } from './claims';

const MINECRAFT_ISSUER = 'https://authorization.franchise.minecraft-services.net/';
const MINECRAFT_AUDIENCE = 'api://auth-minecraft-services/multiplayer';
const MINECRAFT_JWKS_URL = `${MINECRAFT_ISSUER}.well-known/keys`;

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

export interface MinecraftClientTokenVerifierOptions {
  /** Override only when using a compatible trusted authentication service. */
  readonly issuer?: string;
  /** Override only when using a compatible trusted authentication service. */
  readonly audience?: string | string[];
  /** Override the trusted JWKS endpoint. The URL is never taken from the client assertion. */
  readonly jwksUrl?: string | URL;
}

/**
 * Creates a verifier for GameServerToken JWTs issued by Minecraft's authorization service.
 * The JWKS is fetched lazily on the first assertion and cached by `jose`.
 */
export function createMinecraftClientTokenVerifier(
  options: MinecraftClientTokenVerifierOptions = {},
): VerifyClientToken {
  const issuer = options.issuer ?? MINECRAFT_ISSUER;
  const audience = options.audience ?? MINECRAFT_AUDIENCE;
  const keys = createRemoteJWKSet(new URL(options.jwksUrl ?? MINECRAFT_JWKS_URL));

  return async (token): Promise<NetherNetIdentity> => {
    const { payload } = await jwtVerify(token, keys, {
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
    const key = createPublicKey({
      key: Buffer.from(value, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return validateClientPublicKey(await exportJWK(key));
  }
  return validateClientPublicKey(value);
}

function validateClientPublicKey(value: unknown): JWK {
  const result = v.safeParse(clientPublicJwkSchema, value);
  if (!result.success) throw new Error('Invalid GameServerToken client public key');
  return result.output;
}
