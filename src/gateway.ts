import EventEmitter from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { proxyFetch } from 'httpxy';
import { InvalidRequestBodyError, RequestTooLargeError } from './errors';
import { extractUntrustedClientIdentity, verifyClientIdentity } from './identity';
import { createRequest, readBody, writeResponse, writeResponseWhileDraining } from './http';
import type {
  GatewayMiddleware,
  GatewayContext,
  JoinContext,
  NetherNetGatewayErrorEvent,
  NetherNetGatewayInfoEvent,
  NetherNetGatewayJoinEvent,
  NetherNetIdentity,
  ServerInfoContext,
  VerifyClientToken,
} from './types';

export interface NetherNetGatewayEvents {
  requestError: [event: NetherNetGatewayErrorEvent];
  info: [event: NetherNetGatewayInfoEvent];
  join: [event: NetherNetGatewayJoinEvent];
}

export interface NetherNetGatewayOptions {
  upstream: string | ((ctx: GatewayContext) => string);
  verifyClientToken?: VerifyClientToken;
}

export class NetherNetGateway extends EventEmitter<NetherNetGatewayEvents> {
  readonly options: Readonly<NetherNetGatewayOptions>;

  private readonly infoMiddlewares: GatewayMiddleware<ServerInfoContext>[] = [];
  private readonly joinMiddlewares: GatewayMiddleware<JoinContext>[] = [];
  private readonly requestMiddlewares: GatewayMiddleware[] = [];
  server?: Server;

  constructor(options: NetherNetGatewayOptions) {
    super();
    this.options = { ...options };
    this.validateOptions();
  }

  use(middleware: GatewayMiddleware): this;
  use(selector: 'info', middleware: GatewayMiddleware<ServerInfoContext>): this;
  use(selector: 'join', middleware: GatewayMiddleware<JoinContext>): this;
  use(
    selector: 'info' | 'join' | GatewayMiddleware,
    middleware?: GatewayMiddleware<ServerInfoContext> | GatewayMiddleware<JoinContext>,
  ): this {
    if (typeof selector === 'function') {
      this.requestMiddlewares.push(selector);
      return this;
    }

    if (typeof middleware !== 'function') {
      throw new TypeError(`A middleware function is required for ${selector}`);
    }

    if (selector === 'info') {
      this.infoMiddlewares.push(middleware as GatewayMiddleware<ServerInfoContext>);
    } else if (selector === 'join') {
      this.joinMiddlewares.push(middleware as GatewayMiddleware<JoinContext>);
    } else {
      throw new TypeError(`Unknown middleware selector: ${String(selector)}`);
    }

    return this;
  }

  async handleRequest(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = incoming.method ?? 'UNKNOWN';
    const url = incoming.url ?? '/';
    let drainAfterResponse = false;

    let result: Response;
    if (method === 'CONNECT' || method === 'TRACE' || method === 'TRACK') {
      incoming.resume();
      result = new Response('Not Found', { status: 404 });
    } else {
      try {
        const request = await createRequest(incoming);
        const context: GatewayContext = {
          req: request,
          url: new URL(request.url),
          remoteAddress: incoming.socket.remoteAddress,
        };

        try {
          result = await runMiddleware(this.requestMiddlewares, context, async (requestContext) => {
            try {
              return await this.dispatch(requestContext);
            } catch (error) {
              this.emitRequestError('request', error, method, url);
              return new Response('Internal Server Error', { status: 500 });
            }
          });
        } catch (error) {
          this.emitRequestError('middleware', error, method, url);
          result = new Response('Internal Server Error', { status: 500 });
        }
      } catch (error) {
        if (error instanceof RequestTooLargeError) {
          // Keep the connection alive until the 413 is flushed, then discard the remaining body.
          // Closing before that can make unread TCP data turn the response into an ECONNRESET.
          drainAfterResponse = true;
          result = new Response('Request body is too large', { status: 413 });
        } else {
          this.emitRequestError('request', error, method, url);
          result = new Response('Internal Server Error', { status: 500 });
        }
      }
    }

    try {
      if (drainAfterResponse) await writeResponseWhileDraining(incoming, response, result);
      else await writeResponse(response, result);
    } catch (error) {
      this.emitRequestError('response', error, method, url);
      if (!response.headersSent) {
        try {
          await writeResponse(response, new Response('Internal Server Error', { status: 500 }));
        } catch (fallbackError) {
          this.emitRequestError('response', fallbackError, method, url);
          response.destroy();
        }
      } else {
        response.destroy();
      }
    }
  }

  async listen(port: number, host?: string): Promise<void> {
    if (this.server) {
      throw new Error('NetherNetGateway is already listening');
    }

    const server = createServer(this.handleRequest.bind(this));
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;

    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async dispatch(requestContext: GatewayContext): Promise<Response> {
    const { req } = requestContext;
    const url = new URL(req.url);
    const context: GatewayContext = { ...requestContext, req, url };

    if (req.method === 'GET' && url.pathname === '/v1/join') {
      return this.middleware(this.infoMiddlewares, context, undefined, (current) => {
        this.emitObservation('info', current);
      });
    }

    const joinContext = await this.createJoinContext(context);
    if (joinContext instanceof Response) return joinContext;
    return this.middleware(
      this.joinMiddlewares,
      joinContext,
      async (current, replacement) => {
        // A replacement can change every field derived from the request, including verified identity.
        return this.createJoinContext({
          ...current,
          req: replacement,
          url: new URL(replacement.url),
        });
      },
      (current) => this.emitObservation('join', current),
    );
  }

  private async createJoinContext(
    originalContext: GatewayContext,
  ): Promise<JoinContext | Response> {
    let request = originalContext.req;
    const url = new URL(request.url);
    const match = request.method === 'POST' && /^\/v1\/join\/([^/]+)$/.exec(url.pathname);
    if (!match) return new Response('Not Found', { status: 404 });

    let networkId: string;
    try {
      networkId = decodeURIComponent(match[1]);
    } catch {
      return new Response('Invalid network ID', { status: 400 });
    }

    let offer: string;
    try {
      offer = await readBody(request.clone());
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        return new Response('SDP offer is too large', { status: 413 });
      }
      if (error instanceof InvalidRequestBodyError) {
        return new Response('SDP offer must be valid UTF-8', { status: 400 });
      }
      throw error;
    }

    const body = new TextEncoder().encode(offer);
    const headers = new Headers(request.headers);
    headers.delete('transfer-encoding');
    headers.set('content-length', String(body.byteLength));
    request = new Request(request.url, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
    });

    let untrustedIdentity;
    try {
      untrustedIdentity = extractUntrustedClientIdentity(offer);
    } catch {
      return new Response('Invalid client identity', { status: 401 });
    }
    if (!untrustedIdentity) {
      return new Response('Client identity is required', { status: 401 });
    }

    const identity = await this.identity(offer);
    if (identity instanceof Response) return identity;

    return { ...originalContext, req: request, url, networkId, offer, untrustedIdentity, identity };
  }

  private async identity(offer: string): Promise<NetherNetIdentity | undefined | Response> {
    const verifyClientToken = this.options.verifyClientToken;
    if (!verifyClientToken) return undefined;

    try {
      return await verifyClientIdentity(offer, verifyClientToken);
    } catch {
      return new Response('Invalid client identity', { status: 401 });
    }
  }

  private async proxy(context: GatewayContext): Promise<Response> {
    const request = context.req.clone();

    try {
      const upstream =
        typeof this.options.upstream === 'function'
          ? this.options.upstream(context)
          : this.options.upstream;
      if (!request.body) return await proxyFetch(upstream, request);

      // BDS requires a content length and does not read httpxy's chunked request body.
      const body = Buffer.from(await request.arrayBuffer());
      const headers = new Headers(request.headers);
      headers.delete('transfer-encoding');
      headers.set('content-length', String(body.byteLength));

      return await proxyFetch(upstream, request, { body, headers });
    } catch (error) {
      this.emitRequestError('upstream', error, request.method, request.url);
      return new Response('Bad Gateway', { status: 502 });
    }
  }

  private async middleware<CTX extends GatewayContext>(
    middleware: readonly GatewayMiddleware<CTX>[],
    context: CTX,
    replace?: ReplaceContext<CTX>,
    beforeProxy?: (context: CTX) => void,
  ): Promise<Response> {
    try {
      return await runMiddleware(
        middleware,
        context,
        (current) => {
          beforeProxy?.(current);
          return this.proxy(current);
        },
        replace,
      );
    } catch (error) {
      this.emitRequestError('middleware', error, context.req.method, context.req.url);
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  private emitObservation(event: 'info', context: ServerInfoContext): void;
  private emitObservation(event: 'join', context: JoinContext): void;
  private emitObservation(event: 'info' | 'join', context: GatewayContext): void {
    const url = requestTarget(context.req.url);
    const common: NetherNetGatewayInfoEvent = {
      url,
      remoteAddress: context.remoteAddress,
      headers: new Headers(context.req.headers),
    };
    const payload: NetherNetGatewayInfoEvent | NetherNetGatewayJoinEvent =
      event === 'join'
        ? {
            ...common,
            networkId: (context as JoinContext).networkId,
            untrustedIdentity: (context as JoinContext).untrustedIdentity,
            identity: (context as JoinContext).identity,
          }
        : common;

    // Invoke listeners separately so observing cannot change the forwarded request or its response.
    // rawListeners preserves EventEmitter's once() behavior when invoking each listener directly.
    for (const listener of this.rawListeners(event)) {
      try {
        listener.call(this, { ...payload, headers: new Headers(common.headers) });
      } catch (error) {
        try {
          this.emitRequestError('listener', error, context.req.method, url);
        } catch {
          // Even a failing error observer must not change the HTTP result.
        }
      }
    }
  }

  private emitRequestError(
    source: NetherNetGatewayErrorEvent['source'],
    error: unknown,
    method: string,
    url: string,
  ): void {
    this.emit('requestError', { source, error, method, url: requestTarget(url) });
  }

  private validateOptions(): void {
    const upstream = this.options.upstream;
    if (typeof upstream === 'string' && !URL.canParse(upstream)) {
      if (!upstream.startsWith('http://') && !upstream.startsWith('https://')) {
        throw new Error('Upstream URL must start with http:// or https://');
      } else {
        throw new Error('Invalid upstream URL');
      }
    }
  }
}

function requestTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

type ReplaceContext<CTX extends GatewayContext> = (
  context: CTX,
  req: Request,
) => Promise<CTX | Response>;

async function runMiddleware<CTX extends GatewayContext>(
  middleware: readonly GatewayMiddleware<CTX>[],
  context: CTX,
  terminal: (context: CTX) => Promise<Response>,
  replace: ReplaceContext<CTX> = replaceRequest,
): Promise<Response> {
  let lastIndex = -1;

  const dispatch = async (index: number, context: CTX): Promise<Response> => {
    if (index <= lastIndex) throw new Error('next() called multiple times');
    lastIndex = index;

    const current = middleware[index];
    if (!current) return terminal(context);

    const localContext: CTX = {
      ...context,
      req: context.req.clone(),
      url: new URL(context.req.url),
    };
    const response = await current(localContext, async (override) => {
      if (!override) {
        // Headers are Request's only mutable state, so carry them forward without sharing its body.
        replaceHeaders(context.req.headers, localContext.req.headers);
        return dispatch(index + 1, context);
      }
      const replaced = await replace(context, override);
      return replaced instanceof Response ? replaced : dispatch(index + 1, replaced);
    });

    if (!(response instanceof Response)) {
      throw new TypeError('Gateway middleware must return a Response');
    }
    return response;
  };

  return dispatch(0, context);
}

function replaceHeaders(target: Headers, source: Headers): void {
  for (const name of Array.from(target.keys())) target.delete(name);
  for (const [name, value] of source) {
    if (name !== 'content-length' && name !== 'transfer-encoding') target.append(name, value);
  }
}

async function replaceRequest<CTX extends GatewayContext>(
  context: CTX,
  req: Request,
): Promise<CTX> {
  return { ...context, req, url: new URL(req.url) };
}
