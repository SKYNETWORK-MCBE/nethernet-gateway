import { exportJWK, FlattenedSign, generateKeyPair, type JWK } from 'jose';
import { describe, expect, it } from 'vite-plus/test';
import { extractUntrustedClientIdentity, verifyClientIdentity } from './identity';
import type { NetherNetIdentity } from './types';

describe('verifyClientIdentity', () => {
  it('returns identity after token and fingerprint verification', async () => {
    const signedOffer = await createSignedOffer();
    const expected = identity(signedOffer.publicKey);
    let verifiedToken: string | undefined;

    const result = await verifyClientIdentity(signedOffer.offer, (token) => {
      verifiedToken = token;
      return expected;
    });

    expect(verifiedToken).toBe('verified-token');
    expect(result).toEqual(expected);
  });

  it('rejects fingerprints that do not match the detached signature', async () => {
    const signedOffer = await createSignedOffer();

    await expect(
      verifyClientIdentity(signedOffer.offer.replace('AA:BB:CC', '00:BB:CC'), () =>
        identity(signedOffer.publicKey),
      ),
    ).rejects.toThrow();
  });

  it('returns no identity when the offer has no assertion', async () => {
    let verifierCalled = false;

    const result = await verifyClientIdentity('v=0\r\nm=application 9 UDP/DTLS/SCTP', () => {
      verifierCalled = true;
      throw new Error('should not be called');
    });

    expect(result).toBeUndefined();
    expect(verifierCalled).toBe(false);
  });

  it('requires one session-level identity attribute', async () => {
    const assertion = encodeAssertion();
    const misplaced = [
      'v=0',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      `a=identity:${assertion}`,
    ].join('\r\n');

    await expect(
      verifyClientIdentity(misplaced, () => {
        throw new Error('should not be called');
      }),
    ).rejects.toThrow('Identity must be session-level');

    const duplicate = [
      'v=0',
      `a=identity:${assertion}`,
      `a=identity:${assertion}`,
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    ].join('\r\n');

    await expect(
      verifyClientIdentity(duplicate, () => {
        throw new Error('should not be called');
      }),
    ).rejects.toThrow('Multiple identity assertions');
  });

  it('rejects invalid identity envelope and assertion shapes', async () => {
    const invalidEnvelope = offerWithIdentity({
      idp: { domain: 'auth.example', protocol: 'unsupported' },
      assertion: '{}',
    });
    const invalidAssertion = offerWithIdentity({
      idp: { domain: 'auth.example', protocol: 'default' },
      assertion: JSON.stringify({ token: 'token' }),
    });

    await expect(verifyClientIdentity(invalidEnvelope, () => identity({}))).rejects.toThrow(
      'Invalid identity envelope',
    );
    await expect(verifyClientIdentity(invalidAssertion, () => identity({}))).rejects.toThrow(
      'Invalid identity assertion',
    );
  });
});

describe('extractUntrustedClientIdentity', () => {
  it('decodes Minecraft identity claims without verifying the token', () => {
    const claims = {
      xid: '0000000000000000',
      mid: '0000000000000000',
      xname: 'Player',
    };
    const token = [
      'e30',
      Buffer.from(JSON.stringify(claims)).toString('base64url'),
      'signature',
    ].join('.');
    const offer = ['v=0', `a=identity:${encodeAssertion(token)}`].join('\r\n');

    expect(extractUntrustedClientIdentity(offer)).toEqual({
      xuid: claims.xid,
      playFabId: claims.mid,
      gamertag: claims.xname,
      claims,
    });
  });

  it('distinguishes a missing assertion from invalid claims', () => {
    expect(extractUntrustedClientIdentity('v=0')).toBeUndefined();
    expect(() =>
      extractUntrustedClientIdentity(
        ['v=0', `a=identity:${encodeAssertion('invalid-token')}`].join('\r\n'),
      ),
    ).toThrow('Invalid identity token');
    expect(() =>
      extractUntrustedClientIdentity(
        ['v=0', `a=identity:${encodeAssertion(unsignedToken({ xid: '1', mid: '2' }))}`].join(
          '\r\n',
        ),
      ),
    ).toThrow('Invalid identity claims');
  });
});

async function createSignedOffer(): Promise<{ offer: string; publicKey: JWK }> {
  const fingerprint = { algorithm: 'sha-256', digest: 'AA:BB:CC' };
  const { privateKey, publicKey } = await generateKeyPair('ES384', { extractable: true });
  const signed = await new FlattenedSign(
    new TextEncoder().encode(JSON.stringify({ fingerprint: [fingerprint] })),
  )
    .setProtectedHeader({ alg: 'ES384' })
    .sign(privateKey);
  const envelope = {
    idp: { domain: 'auth.example', protocol: 'default' },
    assertion: JSON.stringify({
      token: 'verified-token',
      fingerprints: `${signed.protected}..${signed.signature}`,
    }),
  };

  return {
    offer: [
      'v=0',
      `a=fingerprint:${fingerprint.algorithm} ${fingerprint.digest}`,
      `a=identity:${Buffer.from(JSON.stringify(envelope)).toString('base64')}`,
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      '',
    ].join('\r\n'),
    publicKey: await exportJWK(publicKey),
  };
}

function encodeAssertion(token = 'token'): string {
  return encodeIdentity({
    idp: { domain: 'auth.example', protocol: 'default' },
    assertion: JSON.stringify({ token, fingerprints: 'unused' }),
  });
}

function unsignedToken(claims: Readonly<Record<string, unknown>>): string {
  return ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
}

function offerWithIdentity(value: unknown): string {
  return ['v=0', `a=identity:${encodeIdentity(value)}`].join('\r\n');
}

function encodeIdentity(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function identity(cpk: JWK): NetherNetIdentity {
  return {
    xuid: '0000000000000000',
    playFabId: '0000000000000000',
    gamertag: 'Player',
    cpk,
    claims: { xid: '0000000000000000', mid: '0000000000000000', xname: 'Player', cpk },
  };
}
