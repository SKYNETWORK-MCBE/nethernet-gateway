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

describe('createMinecraftClientTokenVerifier with a JWKS store', () => {
  const issuer = 'https://issuer.example/';
  const audience = 'minecraft-test';
  // Nothing listens here, so a verification that fetches the JWKS fails.
  const unreachable = 'http://127.0.0.1:1/keys';

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

  async function serveJwks(jwks: unknown) {
    const counter = { fetched: 0, url: '' };
    const address = await testServers.serve((_request, response) => {
      counter.fetched++;
      response.end(JSON.stringify(jwks));
    });
    counter.url = `${address}/keys`;
    return counter;
  }

  function withWaitUntil() {
    const pending: Promise<unknown>[] = [];
    const c = {
      ...context(),
      executionCtx: { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) },
    };
    return { c, pending };
  }

  it('verifies with the stored keys without fetching', async () => {
    const { jwks, token } = await setup();
    interface Env {
      JWKS: typeof jwks;
    }
    const sets: unknown[] = [];
    const verify = createMinecraftClientTokenVerifier<{ Bindings: Env }>({
      issuer,
      audience,
      jwksUrl: unreachable,
      jwks: {
        get: (c) => c.env.JWKS,
        set: (_c, updated) => void sets.push(updated),
      },
    });

    await expect(verify(token, context<{ Bindings: Env }>({ JWKS: jwks }))).resolves.toMatchObject({
      gamertag: 'Player',
    });
    expect(sets).toEqual([]);
  });

  it('fetches and stores the keys when nothing is stored', async () => {
    const { jwks, token } = await setup();
    const remote = await serveJwks(jwks);
    const store: { jwks?: unknown } = {};
    const { c, pending } = withWaitUntil();
    const verify = createMinecraftClientTokenVerifier({
      issuer,
      audience,
      jwksUrl: remote.url,
      jwks: {
        get: () => store.jwks as typeof jwks | undefined,
        set: (received, updated) => {
          expect(received).toBe(c);
          store.jwks = updated;
        },
      },
    });

    await expect(verify(token, c)).resolves.toMatchObject({ gamertag: 'Player' });
    await Promise.all(pending);
    expect(store.jwks).toEqual(jwks);

    // The stored keys now verify without another fetch or store.
    await expect(verify(token, c)).resolves.toMatchObject({ gamertag: 'Player' });
    expect(remote.fetched).toBe(1);
    expect(pending).toHaveLength(1);
  });

  it('fetches when the stored keys lack the key of the token', async () => {
    const { jwks, token } = await setup();
    const remote = await serveJwks(jwks);
    const store = { jwks: { keys: [{ ...jwks.keys[0], kid: 'rotated-out' }] } };
    const { c, pending } = withWaitUntil();
    const verify = createMinecraftClientTokenVerifier({
      issuer,
      audience,
      jwksUrl: remote.url,
      jwks: { get: () => store.jwks, set: (_c, updated) => void (store.jwks = updated as never) },
    });

    await expect(verify(token, c)).resolves.toMatchObject({ gamertag: 'Player' });
    await Promise.all(pending);
    expect(remote.fetched).toBe(1);
    expect(store.jwks).toEqual(jwks);
  });

  it('rejects a token whose key is neither stored nor fetched', async () => {
    const { token } = await setup();
    const other = await setup();
    const remote = await serveJwks({ keys: [{ ...other.jwks.keys[0], kid: 'another' }] });
    const verify = createMinecraftClientTokenVerifier({
      issuer,
      audience,
      jwksUrl: remote.url,
      jwks: { get: () => ({ keys: [{ ...other.jwks.keys[0], kid: 'stored' }] }) },
    });

    await expect(verify(token, context())).rejects.toThrow();
  });

  it('does not fetch when a stored key fails to verify the token', async () => {
    const { jwks } = await setup();
    const forged = await setup();
    const remote = await serveJwks(jwks);
    const verify = createMinecraftClientTokenVerifier({
      issuer,
      audience,
      jwksUrl: remote.url,
      jwks: { get: () => jwks },
    });

    // Same key ID as the stored key, but signed by another key.
    await expect(verify(forged.token, context())).rejects.toThrow();
    expect(remote.fetched).toBe(0);
  });

  it.each([
    ['fails', () => Promise.reject(new Error('store unavailable'))],
    ['returns something that is not a JWKS', () => ({ corrupted: true }) as never],
    ['returns null', () => null],
  ])('fetches when get %s', async (_name, get) => {
    const { jwks, token } = await setup();
    const remote = await serveJwks(jwks);
    const verify = createMinecraftClientTokenVerifier({
      issuer,
      audience,
      jwksUrl: remote.url,
      jwks: { get },
    });

    await expect(verify(token, context())).resolves.toMatchObject({ gamertag: 'Player' });
    expect(remote.fetched).toBe(1);
  });

  it('ignores a failing set', async () => {
    const { jwks, token } = await setup();
    const remote = await serveJwks(jwks);
    let calls = 0;
    const verify = createMinecraftClientTokenVerifier({
      issuer,
      audience,
      jwksUrl: remote.url,
      jwks: {
        set: () => {
          calls++;
          throw new Error('store unavailable');
        },
      },
    });

    await expect(verify(token, context())).resolves.toMatchObject({ gamertag: 'Player' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
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
