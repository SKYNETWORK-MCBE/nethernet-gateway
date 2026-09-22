import { KeyObject } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { createMinecraftClientTokenVerifier } from './verifier';
import { createTestServers } from '../test-server';

const testServers = createTestServers();
afterEach(testServers.closeAll);

describe('createMinecraftClientTokenVerifier', () => {
  it('verifies Minecraft claims and accepts both client public key formats', async () => {
    const issuer = 'https://issuer.example/';
    const audience = 'minecraft-test';
    const auth = await generateKeyPair('RS256', { extractable: true });
    const authJwk = await exportJWK(auth.publicKey);
    authJwk.kid = 'test-key';
    authJwk.alg = 'RS256';
    authJwk.use = 'sig';
    const address = await testServers.serve((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [authJwk] }));
    });
    const verify = createMinecraftClientTokenVerifier({
      issuer,
      audience,
      jwksUrl: `${address}/keys`,
    });

    const client = await generateKeyPair('ES384', { extractable: true });
    const clientJwk = await exportJWK(client.publicKey);
    const clientDer = KeyObject.from(client.publicKey)
      .export({ format: 'der', type: 'spki' })
      .toString('base64');

    for (const cpk of [clientJwk, clientDer]) {
      const token = await tokenWithClaims(auth.privateKey, issuer, audience, cpk);
      const identity = await verify(token);

      expect(identity).toEqual({
        xuid: '0000000000000000',
        playFabId: '0000000000000000',
        gamertag: 'Player',
        cpk: clientJwk,
        claims: expect.objectContaining({
          xid: '0000000000000000',
          mid: '0000000000000000',
          xname: 'Player',
        }),
      });
    }

    const claims = {
      xid: '0000000000000000',
      mid: '0000000000000000',
      xname: 'Player',
      cpk: clientJwk,
    };
    const missingExpiration = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .sign(auth.privateKey);
    const missingIssuedAt = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime('5m')
      .sign(auth.privateKey);

    await expect(verify(missingExpiration)).rejects.toThrow('Invalid GameServerToken claims');
    await expect(verify(missingIssuedAt)).rejects.toThrow('Invalid GameServerToken claims');
  });

  it('rejects tokens from an unexpected issuer', async () => {
    const auth = await generateKeyPair('RS256', { extractable: true });
    const authJwk = await exportJWK(auth.publicKey);
    authJwk.kid = 'test-key';
    const address = await testServers.serve((_request, response) => {
      response.end(JSON.stringify({ keys: [authJwk] }));
    });
    const verify = createMinecraftClientTokenVerifier({
      issuer: 'https://expected.example/',
      audience: 'minecraft-test',
      jwksUrl: `${address}/keys`,
    });
    const client = await generateKeyPair('ES384', { extractable: true });
    const token = await tokenWithClaims(
      auth.privateKey,
      'https://unexpected.example/',
      'minecraft-test',
      await exportJWK(client.publicKey),
    );

    await expect(verify(token)).rejects.toThrow();
  });
});

async function tokenWithClaims(
  privateKey: CryptoKey,
  issuer: string,
  audience: string,
  cpk: JWK | string,
): Promise<string> {
  return new SignJWT({
    xid: '0000000000000000',
    mid: '0000000000000000',
    xname: 'Player',
    cpk,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}
