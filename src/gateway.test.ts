import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { NetherNetGateway } from './gateway';
import type { NetherNetGatewayErrorEvent, NetherNetIdentity, NetherNetServerInfo } from './types';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('NetherNetGateway', () => {
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
