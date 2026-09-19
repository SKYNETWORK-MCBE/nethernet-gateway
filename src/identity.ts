import { base64url, decodeProtectedHeader, flattenedVerify, importJWK, type JWK } from 'jose';
import type { NetherNetIdentity, VerifyClientToken } from './types';

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

type IdentityEnvelope = {
  idp: { domain: string; protocol: 'default' };
  assertion: string;
};

type IdentityAssertion = {
  token: string;
  fingerprints: string;
};

// The callback verifies the token; the token's `cpk` public key must also verify the offer's SDP fingerprints:
// https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/#51-validating-the-client-assertion-in-the-offer
export async function verifyClientIdentity(
  offer: string,
  verifyClientToken: VerifyClientToken,
): Promise<NetherNetIdentity | undefined> {
  const assertion = parseIdentityAssertion(offer);
  if (!assertion) return undefined;

  const identity = await verifyClientToken(assertion.token);
  validateIdentity(identity);
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
  const envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as IdentityEnvelope;
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    typeof envelope.idp?.domain !== 'string' ||
    envelope.idp.protocol !== 'default' ||
    typeof envelope.assertion !== 'string'
  ) {
    throw new Error('Invalid identity envelope');
  }

  const assertion = JSON.parse(envelope.assertion) as IdentityAssertion;
  if (
    !assertion ||
    typeof assertion !== 'object' ||
    typeof assertion.token !== 'string' ||
    typeof assertion.fingerprints !== 'string'
  ) {
    throw new Error('Invalid identity assertion');
  }
  return assertion;
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

function validateIdentity(identity: NetherNetIdentity): void {
  if (
    !identity ||
    typeof identity.xuid !== 'string' ||
    identity.xuid.length === 0 ||
    !identity.claims ||
    typeof identity.claims !== 'object' ||
    !identity.cpk ||
    typeof identity.cpk !== 'object' ||
    identity.cpk.kty === 'oct'
  ) {
    throw new Error('Invalid verified identity');
  }
}
