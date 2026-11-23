import { KeyObject } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { GatewayContext, GatewayEnv } from '../types';
import { createMinecraftClientTokenVerifier, MINECRAFT_JWKS_URL } from './verifier';
import { createTestServers } from '../test-helpers';

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
      const identity = await verify(token, context());

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

    await expect(verify(missingExpiration, context())).rejects.toThrow(
      'Invalid GameServerToken claims',
    );
    await expect(verify(missingIssuedAt, context())).rejects.toThrow(
      'Invalid GameServerToken claims',
    );
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

    await expect(verify(token, context())).rejects.toThrow();
  });
});

describe('createMinecraftClientTokenVerifier with supplied keys', () => {
  const issuer = 'https://issuer.example/';
  const audience = 'minecraft-test';
  // Nothing listens here, so a verification that fetches the JWKS fails.
  const jwksUrl = 'http://127.0.0.1:1/keys';

  async function setup() {
    const auth = await generateKeyPair('RS256', { extractable: true });
    const authJwk = { ...(await exportJWK(auth.publicKey)), kid: 'test-key', alg: 'RS256' };
    const client = await generateKeyPair('ES384', { extractable: true });
    const token = await tokenWithClaims(
      auth.privateKey,
      issuer,
      audience,
      await exportJWK(client.publicKey),
    );
    return { jwks: { keys: [authJwk] }, token };
  }

  it('verifies with a supplied JWKS without fetching', async () => {
    const { jwks, token } = await setup();
    const verify = createMinecraftClientTokenVerifier({ issuer, audience, jwksUrl, jwks });

    await expect(verify(token, context())).resolves.toMatchObject({ gamertag: 'Player' });
  });

  it('reads the JWKS from the request context', async () => {
    const { jwks, token } = await setup();
    interface Env {
      JWKS: typeof jwks;
    }
    const verify = createMinecraftClientTokenVerifier<{ Bindings: Env }>({
      issuer,
      audience,
      jwksUrl,
      jwks: async (c) => c.env.JWKS,
    });

    await expect(verify(token, context<{ Bindings: Env }>({ JWKS: jwks }))).resolves.toMatchObject({
      gamertag: 'Player',
    });
  });

  it('rejects a token signed by a key outside the supplied JWKS', async () => {
    const { token } = await setup();
    const other = await setup();
    const verify = createMinecraftClientTokenVerifier({
      issuer,
      audience,
      jwksUrl,
      jwks: other.jwks,
    });

    await expect(verify(token, context())).rejects.toThrow();
  });

  it('fetches jwksUrl when the function supplies nothing', async () => {
    const { jwks, token } = await setup();
    let fetched = 0;
    const address = await testServers.serve((_request, response) => {
      fetched++;
      response.end(JSON.stringify(jwks));
    });
    const verify = createMinecraftClientTokenVerifier({
      issuer,
      audience,
      jwksUrl: `${address}/keys`,
      jwks: () => undefined,
    });

    await expect(verify(token, context())).resolves.toMatchObject({ gamertag: 'Player' });
    expect(fetched).toBe(1);
  });

  it('exports the Minecraft JWKS URL', () => {
    expect(MINECRAFT_JWKS_URL).toBe(
      'https://authorization.franchise.minecraft-services.net/.well-known/keys',
    );
  });
});

function context<E extends GatewayEnv = GatewayEnv>(env?: unknown): GatewayContext<E> {
  const req = new Request('http://localhost/v1/join/1', { method: 'POST' });
  return {
    req,
    url: new URL(req.url),
    remoteAddress: undefined,
    env,
    executionCtx: undefined,
  } as GatewayContext<E>;
}

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
