import EventEmitter from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { proxyFetch } from 'httpxy';
import { verifyClientIdentity } from './identity';
import { createRequest, readBody, RequestTooLargeError, requestUrl, writeResponse } from './http';
import type {
  GatewayContext,
  GatewayMiddleware,
  JoinContext,
  NetherNetGatewayErrorEvent,
  NetherNetIdentity,
  Next,
  ServerInfoContext,
  VerifyClientToken,
} from './types';

export interface NetherNetGatewayEvents {
  requestError: [event: NetherNetGatewayErrorEvent];
}

export interface NetherNetGatewayOptions {
  upstream: string;
  verifyClientToken?: VerifyClientToken;
  requireClientIdentity?: boolean;
}

export class NetherNetGateway extends EventEmitter<NetherNetGatewayEvents> {
  readonly options: Readonly<NetherNetGatewayOptions>;

  private readonly infoMiddlewares: GatewayMiddleware<ServerInfoContext>[] = [];
  private readonly joinMiddlewares: GatewayMiddleware<JoinContext>[] = [];
  server?: Server;

  constructor(options: NetherNetGatewayOptions) {
    super();

    if (options.requireClientIdentity && !options.verifyClientToken) {
      throw new TypeError('verifyClientToken is required when requireClientIdentity is true');
    }

    this.options = { ...options };
  }

  use(selector: 'info', middleware: GatewayMiddleware<ServerInfoContext>): this;
  use(selector: 'join', middleware: GatewayMiddleware<JoinContext>): this;
  use(
    selector: 'info' | 'join',
    middleware: GatewayMiddleware<ServerInfoContext> | GatewayMiddleware<JoinContext>,
  ): this {
    if (selector === 'info') {
      this.infoMiddlewares.push(middleware as GatewayMiddleware<ServerInfoContext>);
    } else {
      this.joinMiddlewares.push(middleware as GatewayMiddleware<JoinContext>);
    }

    return this;
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let result: Response;
    try {
      result = await this.dispatch(request);
    } catch (error) {
      this.emitRequestError('request', error, request.method ?? 'UNKNOWN', request.url ?? '/');
      result = new Response('Internal Server Error', { status: 500 });
    }

    try {
      await writeResponse(response, result);
    } catch (error) {
      this.emitRequestError('response', error, request.method ?? 'UNKNOWN', request.url ?? '/');
      if (!response.headersSent) {
        try {
          await writeResponse(response, new Response('Internal Server Error', { status: 500 }));
        } catch (fallbackError) {
          this.emitRequestError(
            'response',
            fallbackError,
            request.method ?? 'UNKNOWN',
            request.url ?? '/',
          );
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

  private async dispatch(incoming: IncomingMessage): Promise<Response> {
    const url = requestUrl(incoming);

    if (incoming.method === 'GET' && url.pathname === '/v1/join') {
      const request = createRequest(incoming, url);
      return this.middleware(this.infoMiddlewares, { request });
    }

    const match = incoming.method === 'POST' && /^\/v1\/join\/([^/]+)$/.exec(url.pathname);
    if (!match) return new Response('Not Found', { status: 404 });

    let networkId: string;
    try {
      networkId = decodeURIComponent(match[1]);
    } catch {
      return new Response('Invalid network ID', { status: 400 });
    }

    let offer: string;
    try {
      offer = await readBody(incoming);
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        return new Response('SDP offer is too large', { status: 413 });
      }
      throw error;
    }

    const request = createRequest(incoming, url, offer);
    const identity = await this.identity(offer);
    if (identity instanceof Response) return identity;

    const context: JoinContext = { request, networkId, offer, identity };
    return this.middleware(this.joinMiddlewares, context);
  }

  private async identity(offer: string): Promise<NetherNetIdentity | undefined | Response> {
    const verifyClientToken = this.options.verifyClientToken;
    if (!verifyClientToken) return undefined;

    // The guide leaves missing assertions to server policy; this option makes them mandatory (§5.1):
    // https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/#51-validating-the-client-assertion-in-the-offer
    let identity: NetherNetIdentity | undefined;
    try {
      identity = await verifyClientIdentity(offer, verifyClientToken);
    } catch {
      return new Response('Invalid client identity', { status: 401 });
    }

    if (!identity && this.options.requireClientIdentity) {
      return new Response('Client identity is required', { status: 401 });
    }
    return identity;
  }

  private async proxy(request: Request): Promise<Response> {
    // Middleware may have replaced the body, so let the transport recompute the length.
    request.headers.delete('content-length');

    try {
      return await proxyFetch(this.options.upstream, request);
    } catch (error) {
      this.emitRequestError('upstream', error, request.method, request.url);
      return new Response('Bad Gateway', { status: 502 });
    }
  }

  private async middleware<Context extends GatewayContext>(
    middleware: readonly GatewayMiddleware<Context>[],
    context: Context,
  ): Promise<Response> {
    try {
      return await runMiddleware(middleware, context, (request) =>
        this.proxy((request ?? context.request).clone()),
      );
    } catch (error) {
      this.emitRequestError('middleware', error, context.request.method, context.request.url);
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  private emitRequestError(
    source: NetherNetGatewayErrorEvent['source'],
    error: unknown,
    method: string,
    url: string,
  ): void {
    this.emit('requestError', { source, error, method, url });
  }
}

async function runMiddleware<Context extends GatewayContext>(
  middleware: readonly GatewayMiddleware<Context>[],
  context: Context,
  terminal: Next,
): Promise<Response> {
  let lastIndex = -1;

  const dispatch = async (index: number, context: Context): Promise<Response> => {
    if (index <= lastIndex) throw new Error('next() called multiple times');
    lastIndex = index;

    const current = middleware[index];
    const response = current
      ? await current(context, async (override) =>
          dispatch(index + 1, override ? await replaceRequest(context, override) : context),
        )
      : await terminal(context.request);

    if (!(response instanceof Response)) {
      throw new TypeError('Gateway middleware must return a Response');
    }
    return response;
  };

  return dispatch(0, context);
}

async function replaceRequest<Context extends GatewayContext>(
  context: Context,
  request: Request,
): Promise<Context> {
  const replaced = { ...context, request };
  return 'offer' in context ? { ...replaced, offer: await request.clone().text() } : replaced;
}
