import {
  Agent,
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import { exportJWK, FlattenedSign, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { NetherNetGateway } from './gateway';
import type { NetherNetGatewayErrorEvent, NetherNetIdentity, NetherNetServerInfo } from './types';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('NetherNetGateway', () => {
  it('runs request middleware around every route and allows early responses', async () => {
    let upstreamRequests = 0;
    const upstream = await serve((_request, response) => {
      upstreamRequests++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(serverInfo));
    });
    const gateway = new NetherNetGateway({ upstream });
    const order: string[] = [];
    gateway.use(async (context, next) => {
      expect(context.request).toBeInstanceOf(Request);
      expect(new URL(context.request.url)).toEqual(context.url);
      order.push(`before:${context.url.pathname}`);
      if (context.url.searchParams.has('block')) {
        return new Response('Blocked', { status: 418 });
      }
      const response = await next();
      order.push(`after:${response.status}`);
      return response;
    });
    const address = await serve(gateway.handleRequest.bind(gateway));

    const blocked = await fetch(`${address}/v1/join?block`);
    const allowed = await fetch(`${address}/v1/join`);

    expect(blocked.status).toBe(418);
    expect(allowed.status).toBe(200);
    expect(upstreamRequests).toBe(1);
    expect(order).toEqual(['before:/v1/join', 'before:/v1/join', 'after:200']);
  });

  it('reuses a connection after middleware returns before proxying', async () => {
    const upstream = await serve((_request, response) => {
      response.end('ok');
    });
    const gateway = new NetherNetGateway({ upstream });
    gateway.use((context, next) =>
      context.url.pathname === '/early' ? new Response(null, { status: 204 }) : next(),
    );
    const address = await serve(gateway.handleRequest.bind(gateway));
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });

    try {
      const first = await sendHttp(address, '/early', {
        agent,
        method: 'POST',
        body: 'offer',
      });
      const second = await sendHttp(address, '/v1/join', { agent });

      expect(first.status).toBe(204);
      expect(second.status).toBe(200);
      expect(second.socket).toBe(first.socket);
    } finally {
      agent.destroy();
    }
  });

  it('survives an aborted request body and rejects unsupported Fetch methods', async () => {
    const upstream = await serve((_request, response) => {
      response.end('ok');
    });
    const gateway = new NetherNetGateway({ upstream });
    const address = await serve(gateway.handleRequest.bind(gateway));

    await abortRequest(address);
    const trace = await sendHttp(address, '/v1/join', { method: 'TRACE' });
    const healthy = await fetch(`${address}/v1/join`);

    expect(trace.status).toBe(404);
    expect(healthy.status).toBe(200);
  });

  it('lets request middleware replace the request before routing', async () => {
    const upstream = await serve((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(serverInfo));
    });
    const gateway = new NetherNetGateway({ upstream });
    gateway.use((context, next) =>
      next(
        new Request(new URL('/v1/join', context.request.url), {
          method: 'GET',
          headers: context.request.headers,
        }),
      ),
    );
    const address = await serve(gateway.handleRequest.bind(gateway));

    const response = await fetch(`${address}/rewritten`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(serverInfo);
  });

  it('isolates request bodies and URLs between middleware', async () => {
    let received: string | undefined;
    const upstream = await serve(async (request, response) => {
      received = await body(request);
      response.end('answer');
    });
    const gateway = new NetherNetGateway({ upstream });
    const seen: string[] = [];
    gateway.use(async (context, next) => {
      seen.push(await context.request.text());
      context.url.pathname = '/other';
      return next();
    });
    gateway.use(async (context, next) => {
      seen.push(await context.request.text());
      return next();
    });
    const address = await serve(gateway.handleRequest.bind(gateway));

    const response = await fetch(`${address}/v1/join/1`, { method: 'POST', body: 'offer' });

    expect(response.status).toBe(200);
    expect(seen).toEqual(['offer', 'offer']);
    expect(received).toBe('offer');
  });

  it('runs info middleware around the upstream response', async () => {
    const order: string[] = [];
    const upstream = await serve((_request, response) => {
      order.push('upstream');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(serverInfo));
    });
    const gateway = new NetherNetGateway({ upstream });

    gateway.use('info', async (_context, next) => {
      order.push('first:before');
      const response = await next();
      order.push('first:after');
      return response;
    });
    gateway.use('info', async (_context, next) => {
      order.push('second:before');
      const response = await next();
      const info = (await response.json()) as NetherNetServerInfo;
      order.push('second:after');
      return Response.json({ ...info, name: 'Gateway' });
    });
    gateway.use('join', () => new Response('wrong stack', { status: 418 }));

    const address = await serve(gateway.handleRequest.bind(gateway));
    const response = await fetch(`${address}/v1/join`);

    expect(await response.json()).toEqual({ ...serverInfo, name: 'Gateway' });
    expect(order).toEqual([
      'first:before',
      'second:before',
      'upstream',
      'second:after',
      'first:after',
    ]);
  });

  it('proxies join metadata and SDP without requiring identity by default', async () => {
    let received: { method?: string; url?: string; header?: string; body?: string } = {};
    const upstream = await serve(async (request, response) => {
      received = {
        method: request.method,
        url: request.url,
        header: request.headers['x-test'] as string,
        body: await body(request),
      };
      response.setHeader('content-type', 'application/sdp');
      response.end('answer');
    });
    const gateway = new NetherNetGateway({ upstream });
    let contextIdentity: NetherNetIdentity | undefined;
    gateway.use('join', (context, next) => {
      expect(context.networkId).toBe('network id');
      expect(context.url.searchParams.get('source')).toBe('test');
      expect(context.offer).toBe('offer');
      contextIdentity = context.identity;
      return next();
    });

    const address = await serve(gateway.handleRequest.bind(gateway));
    const response = await fetch(`${address}/v1/join/network%20id?source=test`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp', 'x-test': 'kept' },
      body: 'offer',
    });

    expect(await response.text()).toBe('answer');
    expect(contextIdentity).toBeUndefined();
    expect(received).toEqual({
      method: 'POST',
      url: '/v1/join/network%20id?source=test',
      header: 'kept',
      body: 'offer',
    });
  });

  it('lets join middleware replace the offer and the answer', async () => {
    let received: string | undefined;
    const upstream = await serve(async (request, response) => {
      received = await body(request);
      response.setHeader('content-type', 'application/sdp');
      response.end('a long upstream answer');
    });
    const gateway = new NetherNetGateway({ upstream });
    gateway.use('join', async (context, next) => {
      const replaced = new Request(context.request, {
        method: 'POST',
        body: `rewritten ${context.offer}`,
      });
      const response = await next(replaced);

      return new Response((await response.text()).slice(0, 6), response);
    });

    const address = await serve(gateway.handleRequest.bind(gateway));
    const response = await fetch(`${address}/v1/join/1`, { method: 'POST', body: 'offer' });

    expect(received).toBe('rewritten offer');
    expect(await response.text()).toBe('a long');
    expect(response.headers.get('content-type')).toBe('application/sdp');
  });

  it('hands the replaced offer to the middleware below it', async () => {
    let received: string | undefined;
    const upstream = await serve(async (request, response) => {
      received = await body(request);
      response.end('answer');
    });
    const gateway = new NetherNetGateway({ upstream });
    const seen: { offer: string; body: string }[] = [];

    gateway.use('join', (context, next) =>
      next(new Request(context.request, { method: 'POST', body: `rewritten ${context.offer}` })),
    );
    gateway.use('join', async (context, next) => {
      seen.push({ offer: context.offer, body: await context.request.clone().text() });
      return next();
    });

    const address = await serve(gateway.handleRequest.bind(gateway));
    await fetch(`${address}/v1/join/1`, { method: 'POST', body: 'offer' });

    expect(seen).toEqual([{ offer: 'rewritten offer', body: 'rewritten offer' }]);
    expect(received).toBe('rewritten offer');
  });

  it('rebuilds join metadata and identity after replacing a request', async () => {
    const signed = await createSignedOffer('verified-token', 'verified-xuid');
    const upstream = await serve((_request, response) => {
      response.end('answer');
    });
    let verifications = 0;
    const gateway = new NetherNetGateway({
      upstream,
      verifyClientToken: (token) => {
        expect(token).toBe('verified-token');
        verifications++;
        return signed.identity;
      },
    });
    const seen: Array<{ identity?: string; networkId: string; offer: string }> = [];
    gateway.use('join', (context, next) => {
      seen.push({
        identity: context.identity?.xuid,
        networkId: context.networkId,
        offer: context.offer,
      });
      return next(
        new Request(new URL('/v1/join/replaced', context.request.url), {
          method: 'POST',
          body: signed.offer,
        }),
      );
    });
    gateway.use('join', (context, next) => {
      seen.push({
        identity: context.identity?.xuid,
        networkId: context.networkId,
        offer: context.offer,
      });
      return next();
    });
    const address = await serve(gateway.handleRequest.bind(gateway));

    const response = await fetch(`${address}/v1/join/original`, {
      method: 'POST',
      body: signed.offer,
    });

    expect(response.status).toBe(200);
    expect(verifications).toBe(2);
    expect(seen).toEqual([
      { identity: 'verified-xuid', networkId: 'original', offer: signed.offer },
      { identity: 'verified-xuid', networkId: 'replaced', offer: signed.offer },
    ]);
  });

  it('validates replacement offer size and UTF-8 encoding', async () => {
    const upstream = await serve((_request, response) => {
      response.end('answer');
    });
    const oversized = new NetherNetGateway({ upstream });
    oversized.use('join', (context, next) =>
      next(
        new Request(context.request, {
          method: 'POST',
          body: Buffer.alloc(1024 * 1024 + 1),
        }),
      ),
    );
    const oversizedAddress = await serve(oversized.handleRequest.bind(oversized));
    const invalidUtf8 = new NetherNetGateway({ upstream });
    const invalidUtf8Address = await serve(invalidUtf8.handleRequest.bind(invalidUtf8));

    const oversizedResponse = await fetch(`${oversizedAddress}/v1/join/1`, {
      method: 'POST',
      body: 'offer',
    });
    const invalidUtf8Response = await fetch(`${invalidUtf8Address}/v1/join/1`, {
      method: 'POST',
      body: new Uint8Array([0xc3, 0x28]),
    });

    expect(oversizedResponse.status).toBe(413);
    expect(invalidUtf8Response.status).toBe(400);
  });

  it('supports optional and required client identity modes', async () => {
    const upstream = await serve((_request, response) => {
      response.end('answer');
    });
    const optional = new NetherNetGateway({
      upstream,
      verifyClientToken: () => {
        throw new Error('not called without an assertion');
      },
    });
    const required = new NetherNetGateway({
      upstream,
      requireClientIdentity: true,
      verifyClientToken: () => {
        throw new Error('not called without an assertion');
      },
    });
    const optionalAddress = await serve(optional.handleRequest.bind(optional));
    const requiredAddress = await serve(required.handleRequest.bind(required));

    const optionalResponse = await fetch(`${optionalAddress}/v1/join/1`, {
      method: 'POST',
      body: 'v=0\r\n',
    });
    const requiredResponse = await fetch(`${requiredAddress}/v1/join/1`, {
      method: 'POST',
      body: 'v=0\r\n',
    });

    expect(optionalResponse.status).toBe(200);
    expect(requiredResponse.status).toBe(401);
    expect(() => new NetherNetGateway({ upstream, requireClientIdentity: true })).toThrow(
      /verifyClientToken/u,
    );
  });

  it('rejects failed token verification and oversized offers before proxying', async () => {
    let upstreamRequests = 0;
    const upstream = await serve((_request, response) => {
      upstreamRequests++;
      response.end('answer');
    });
    const gateway = new NetherNetGateway({
      upstream,
      verifyClientToken: () => {
        throw new Error('invalid token');
      },
    });
    let middlewareRequests = 0;
    gateway.use((_context, next) => {
      middlewareRequests++;
      return next();
    });
    let requestErrors = 0;
    gateway.on('requestError', () => requestErrors++);
    const address = await serve(gateway.handleRequest.bind(gateway));

    const invalidToken = await fetch(`${address}/v1/join/1`, {
      method: 'POST',
      body: offerWithIdentityAssertion('invalid-token'),
    });
    const oversized = await fetch(`${address}/v1/join/2`, {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 1),
    });

    expect(invalidToken.status).toBe(401);
    expect(oversized.status).toBe(413);
    expect(upstreamRequests).toBe(0);
    expect(requestErrors).toBe(0);
    expect(middlewareRequests).toBe(1);
  });

  it('turns middleware and upstream failures into 500 and 502 responses', async () => {
    const brokenMiddleware = new NetherNetGateway({ upstream: 'http://127.0.0.1:1' });
    const middlewareErrors: NetherNetGatewayErrorEvent[] = [];
    brokenMiddleware.on('requestError', (event) => middlewareErrors.push(event));
    brokenMiddleware.use('info', () => {
      throw new Error('boom');
    });
    const brokenMiddlewareAddress = await serve(
      brokenMiddleware.handleRequest.bind(brokenMiddleware),
    );

    const unreachable = new NetherNetGateway({ upstream: 'http://127.0.0.1:1' });
    const upstreamErrors: NetherNetGatewayErrorEvent[] = [];
    unreachable.on('requestError', (event) => upstreamErrors.push(event));
    const unreachableAddress = await serve(unreachable.handleRequest.bind(unreachable));

    expect((await fetch(`${brokenMiddlewareAddress}/v1/join`)).status).toBe(500);
    expect((await fetch(`${unreachableAddress}/v1/join`)).status).toBe(502);
    expect((await fetch(`${unreachableAddress}/other`)).status).toBe(404);
    expect(middlewareErrors).toEqual([
      expect.objectContaining({ source: 'middleware', error: expect.any(Error), method: 'GET' }),
    ]);
    expect(upstreamErrors).toEqual([
      expect.objectContaining({ source: 'upstream', error: expect.any(Error), method: 'GET' }),
    ]);
  });

  it('rejects multiple next calls and can own its server lifecycle', async () => {
    const upstream = await serve((_request, response) => {
      response.end('ok');
    });
    const gateway = new NetherNetGateway({ upstream });
    gateway.use('info', async (_context, next) => {
      await next();
      return next();
    });
    const address = await serve(gateway.handleRequest.bind(gateway));

    expect((await fetch(`${address}/v1/join`)).status).toBe(500);

    const standalone = new NetherNetGateway({ upstream });
    await standalone.listen(0, '127.0.0.1');
    await standalone.close();
  });

  it('rejects incomplete and unknown middleware registrations', () => {
    const gateway = new NetherNetGateway({ upstream: 'http://127.0.0.1:1' });
    const use = gateway.use.bind(gateway) as (...arguments_: unknown[]) => NetherNetGateway;

    expect(() => use('info')).toThrow(/middleware function/u);
    expect(() => use('unknown', () => new Response())).toThrow(/Unknown middleware selector/u);
  });
});

const serverInfo: NetherNetServerInfo = {
  name: 'Upstream',
  protocol: 1,
  version: '1.0.0',
  level: 'World',
  players: 1,
  maxPlayers: 10,
  gameType: 0,
};

function offerWithIdentityAssertion(token: string): string {
  const envelope = {
    idp: { domain: 'auth.example', protocol: 'default' },
    assertion: JSON.stringify({
      token,
      fingerprints: 'unused',
    }),
  };
  const encodedIdentity = Buffer.from(JSON.stringify(envelope)).toString('base64');
  return [
    'v=0',
    `a=identity:${encodedIdentity}`,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    '',
  ].join('\r\n');
}

async function createSignedOffer(
  token: string,
  xuid: string,
): Promise<{ identity: NetherNetIdentity; offer: string }> {
  const fingerprint = { algorithm: 'sha-256', digest: 'AA:BB:CC' };
  const { privateKey, publicKey } = await generateKeyPair('ES384', { extractable: true });
  const signed = await new FlattenedSign(
    new TextEncoder().encode(JSON.stringify({ fingerprint: [fingerprint] })),
  )
    .setProtectedHeader({ alg: 'ES384' })
    .sign(privateKey);
  const cpk = await exportJWK(publicKey);
  const envelope = {
    idp: { domain: 'auth.example', protocol: 'default' },
    assertion: JSON.stringify({
      token,
      fingerprints: `${signed.protected}..${signed.signature}`,
    }),
  };

  return {
    identity: { xuid, cpk, claims: { cpk, xid: xuid } },
    offer: [
      'v=0',
      `a=fingerprint:${fingerprint.algorithm} ${fingerprint.digest}`,
      `a=identity:${Buffer.from(JSON.stringify(envelope)).toString('base64')}`,
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      '',
    ].join('\r\n'),
  };
}

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function sendHttp(
  address: string,
  path: string,
  options: { agent?: Agent; body?: string; method?: string } = {},
): Promise<{ socket: Socket; status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, address), {
      agent: options.agent,
      method: options.method,
    });
    request.once('error', reject);
    request.once('response', (response) => {
      const socket = response.socket;
      response.resume();
      response.once('end', () => resolve({ socket, status: response.statusCode ?? 0 }));
    });
    request.end(options.body);
  });
}

async function abortRequest(address: string): Promise<void> {
  const url = new URL(address);
  await new Promise<void>((resolve) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(
        'POST /v1/join/1 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\npartial',
      );
      socket.destroy();
    });
    socket.once('error', () => {});
    socket.once('close', () => resolve());
  });
}
