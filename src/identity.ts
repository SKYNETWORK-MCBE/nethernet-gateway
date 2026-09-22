import { base64url, decodeProtectedHeader, flattenedVerify, importJWK, type JWK } from 'jose';
import * as v from 'valibot';
import {
  minecraftIdentityClaimsSchema,
  normalizeMinecraftIdentityClaims,
} from './minecraft/claims';
import type { NetherNetIdentity, UntrustedNetherNetIdentity, VerifyClientToken } from './types';

const ASYMMETRIC_JWS_ALGORITHMS = [
  'ES256',
  'ES384',
  'ES512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'EdDSA',
] as const;

const identityEnvelopeSchema = v.object({
  idp: v.object({
    domain: v.string(),
    protocol: v.literal('default'),
  }),
  assertion: v.string(),
});

const identityAssertionSchema = v.object({
  token: v.string(),
  fingerprints: v.string(),
});

const claimsSchema = v.record(v.string(), v.unknown());

type IdentityAssertion = v.InferOutput<typeof identityAssertionSchema>;

/** Decodes client-supplied JWT claims without authenticating them. */
export function extractUntrustedClientIdentity(
  offer: string,
): UntrustedNetherNetIdentity | undefined {
  const assertion = parseIdentityAssertion(offer);
  if (!assertion) return undefined;

  const [header, payload, signature, extra] = assertion.token.split('.');
  if (!header || !payload || !signature || extra !== undefined) {
    throw new Error('Invalid identity token');
  }

  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const claimsResult = v.safeParse(claimsSchema, decoded);
  const identityResult = v.safeParse(minecraftIdentityClaimsSchema, decoded);
  if (!claimsResult.success || !identityResult.success) {
    throw new Error('Invalid identity claims');
  }

  return {
    ...normalizeMinecraftIdentityClaims(identityResult.output),
    claims: claimsResult.output,
  };
}

// The callback verifies the token; the token's `cpk` public key must also verify the offer's SDP fingerprints:
// https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/#51-validating-the-client-assertion-in-the-offer
export async function verifyClientIdentity(
  offer: string,
  verifyClientToken: VerifyClientToken,
): Promise<NetherNetIdentity | undefined> {
  const assertion = parseIdentityAssertion(offer);
  if (!assertion) return undefined;

  const identity = await verifyClientToken(assertion.token);
  await verifyFingerprintAssertion(offer, assertion.fingerprints, identity.cpk);
  return identity;
}

function parseIdentityAssertion(offer: string): IdentityAssertion | undefined {
  const lines = offer.split(/\r?\n/u);
  const mediaIndex = lines.findIndex((line) => line.startsWith('m='));
  // The protocol places this session-level attribute before the first media section:
  // https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/#51-validating-the-client-assertion-in-the-offer
  const identityLines = lines.filter((line, index) => {
    if (!line.startsWith('a=identity:')) return false;
    if (mediaIndex !== -1 && index > mediaIndex) throw new Error('Identity must be session-level');
    return true;
  });

  if (identityLines.length === 0) return undefined;
  if (identityLines.length !== 1) throw new Error('Multiple identity assertions');

  const encoded = identityLines[0].slice('a=identity:'.length);
  const envelopeResult = v.safeParse(
    identityEnvelopeSchema,
    JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')),
  );
  if (!envelopeResult.success) {
    throw new Error('Invalid identity envelope');
  }

  const assertionResult = v.safeParse(
    identityAssertionSchema,
    JSON.parse(envelopeResult.output.assertion),
  );
  if (!assertionResult.success) {
    throw new Error('Invalid identity assertion');
  }
  return assertionResult.output;
}

async function verifyFingerprintAssertion(
  offer: string,
  compactJws: string,
  publicKey: JWK,
): Promise<void> {
  const [protectedHeader, detachedPayload, signature, extra] = compactJws.split('.');
  if (!protectedHeader || detachedPayload !== '' || !signature || extra !== undefined) {
    throw new Error('Invalid detached JWS');
  }

  const { alg } = decodeProtectedHeader(compactJws);
  if (
    !alg ||
    !ASYMMETRIC_JWS_ALGORITHMS.includes(alg as (typeof ASYMMETRIC_JWS_ALGORITHMS)[number])
  ) {
    throw new Error('Unsupported fingerprint algorithm');
  }

  const fingerprints = offer.split(/\r?\n/u).flatMap((line) => {
    const match = /^a=fingerprint:(\S+)\s+(.+)$/u.exec(line);
    return match ? [{ algorithm: match[1], digest: match[2] }] : [];
  });
  if (fingerprints.length === 0) throw new Error('Missing SDP fingerprint');

  // The detached JWS omits its payload, so rebuild it from the SDP fingerprints:
  // https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/#51-validating-the-client-assertion-in-the-offer
  const payload = base64url.encode(JSON.stringify({ fingerprint: fingerprints }));
  const key = await importJWK(publicKey, alg);
  await flattenedVerify({ protected: protectedHeader, payload, signature }, key, {
    algorithms: [alg],
  });
}
