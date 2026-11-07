import { Emitter } from './emitter';
import { InvalidRequestBodyError, RequestTooLargeError } from './errors';
import { extractUntrustedClientIdentity, verifyClientIdentity } from './identity';
import { readBody } from './http';
import type {
  ClientInfo,
  ExecutionContext,
  GetConnInfo,
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

export interface NetherNetGatewayEvents<Verified extends boolean = boolean> {
  requestError: [event: NetherNetGatewayErrorEvent];
  info: [event: NetherNetGatewayInfoEvent];
  join: [event: NetherNetGatewayJoinEvent<Verified>];
}

export interface NetherNetGatewayOptions {
  upstream: string | ((ctx: GatewayContext) => string);
  verifyClientToken?: VerifyClientToken;
  /**
   * Resolves `remoteAddress` from the request and `env`. Pass the `getConnInfo` exported by the
   * subpath for your runtime, such as `nethernet-gateway/bun`.
   */
  getConnInfo?: GetConnInfo;
}

export type IsVerified<Options extends NetherNetGatewayOptions> = Options extends {
  verifyClientToken: VerifyClientToken;
}
  ? true
  : Options extends Omit<NetherNetGatewayOptions, 'verifyClientToken'> & {
        verifyClientToken?: undefined;
      }
    ? false
    : boolean;
export class NetherNetGateway<
  out Options extends NetherNetGatewayOptions = NetherNetGatewayOptions,
> extends Emitter<NetherNetGatewayEvents<IsVerified<Options>>> {
  readonly options: Readonly<NetherNetGatewayOptions>;

  private readonly infoMiddlewares: GatewayMiddleware<ServerInfoContext>[] = [];
  private readonly joinMiddlewares: GatewayMiddleware<JoinContext>[] = [];
  private readonly requestMiddlewares: GatewayMiddleware[] = [];

  constructor(options: Options);
  constructor(options: Options) {
    super();
    this.options = Object.freeze({ ...options });
    this.validateOptions();
  }

  use(middleware: GatewayMiddleware): this;
  use(selector: 'info', middleware: GatewayMiddleware<ServerInfoContext>): this;
  use(selector: 'join', middleware: GatewayMiddleware<JoinContext<IsVerified<Options>>>): this;
  use(
    selector: 'info' | 'join' | GatewayMiddleware,
    middleware?:
      | GatewayMiddleware<ServerInfoContext>
      | GatewayMiddleware<JoinContext<IsVerified<Options>>>,
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

  /**
   * Handles a Fetch API request with the runtime's own arguments. It is bound to the gateway, so
   * it can be passed to any server that takes a Fetch handler.
   */
  readonly fetch = async (
    request: Request,
    env?: unknown,
    executionCtx?: ExecutionContext,
  ): Promise<Response> => {
    const { method, url } = request;
    if (method === 'CONNECT' || method === 'TRACE' || method === 'TRACK') {
      return new Response('Not Found', { status: 404 });
    }

    let context: GatewayContext;
    try {
      context = {
        req: mutableRequest(request),
        url: new URL(url),
        // Bun looks the address up by the original request object.
        remoteAddress: this.options.getConnInfo?.({ req: request, env }).remote.address,
        env,
        executionCtx,
      };
    } catch (error) {
      this.emitRequestError('request', error, method, url);
      return new Response('Internal Server Error', { status: 500 });
    }

    try {
      return await runMiddleware(this.requestMiddlewares, context, async (requestContext) => {
        try {
          return await this.dispatch(requestContext);
        } catch (error) {
          this.emitRequestError('request', error, method, url);
          return new Response('Internal Server Error', { status: 500 });
        }
      });
    } catch (error) {
      this.emitRequestError('middleware', error, method, url);
      return new Response('Internal Server Error', { status: 500 });
    }
  };

  private async dispatch(requestContext: GatewayContext): Promise<Response> {
    const { req } = requestContext;
    const url = new URL(req.url);
    const context: GatewayContext = { ...requestContext, req, url };

    if (req.method === 'GET' && url.pathname === '/v1/join') {
      return this.middleware(
        this.infoMiddlewares,
        { ...context, client: clientInfo(url) },
        async (current, replacement) => {
          const url = new URL(replacement.url);
          return { ...current, req: replacement, url, client: clientInfo(url) };
        },
        (current) => this.observe('info', current),
      );
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
      (current) => this.observe('join', current),
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
      const target = upstreamUrl(upstream, new URL(request.url));

      const headers = new Headers(request.headers);
      // The runtime derives these from the target URL and the buffered body.
      for (const name of ['host', 'content-length', 'transfer-encoding', ...HOP_BY_HOP]) {
        headers.delete(name);
      }
      // BDS requires a content length and does not read a chunked request body, so buffer it.
      const body = request.body ? await request.arrayBuffer() : undefined;

      const response = await fetch(target, {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
      });
      return forwardResponse(response);
    } catch (error) {
      this.emitRequestError('upstream', error, request.method, request.url);
      return new Response('Bad Gateway', { status: 502 });
    }
  }

  private async middleware<CTX extends GatewayContext>(
    middleware: readonly GatewayMiddleware<CTX>[],
    context: CTX,
    replace?: ReplaceContext<CTX>,
    observe?: (context: CTX) => Observation,
  ): Promise<Response> {
    // Snapshot the forwarded request, but emit only once the final response is known.
    let observation: Observation | undefined;
    let response: Response;
    try {
      response = await runMiddleware(
        middleware,
        context,
        (current) => {
          observation = observe?.(current);
          return this.proxy(current);
        },
        replace,
      );
    } catch (error) {
      this.emitRequestError('middleware', error, context.req.method, context.req.url);
      response = new Response('Internal Server Error', { status: 500 });
    }
    observation?.(response.status);
    return response;
  }

  private observe(event: 'info', context: ServerInfoContext): Observation;
  private observe(event: 'join', context: JoinContext): Observation;
  private observe(event: 'info' | 'join', context: GatewayContext): Observation {
    const url = requestTarget(context.req.url);
    const common = {
      url,
      remoteAddress: context.remoteAddress,
      headers: new Headers(context.req.headers),
    };
    return (status) => {
      try {
        if (event === 'join') {
          const join = context as JoinContext;
          (this as Emitter<NetherNetGatewayEvents>).emit('join', {
            ...common,
            status,
            networkId: join.networkId,
            untrustedIdentity: join.untrustedIdentity,
            identity: join.identity,
          });
        } else {
          this.emit('info', {
            ...common,
            status,
            client: (context as ServerInfoContext).client,
          });
        }
      } catch (error) {
        try {
          this.emitRequestError('listener', error, context.req.method, url);
        } catch {
          // Even a failing error observer must not change the HTTP result.
        }
      }
    };
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

// Runtime servers such as Deno and Workers pass immutable headers. Copy from the URL rather than
// the Request so the copy does not follow its signal, which Deno aborts once the response is sent.
function mutableRequest(request: Request): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    duplex: 'half',
  } as RequestInit);
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade'];

function upstreamUrl(upstream: string, requestUrl: URL): URL {
  const target = new URL(upstream);
  // Requests are forwarded below the upstream's base path.
  const basePath = target.pathname.replace(/\/+$/u, '');
  target.pathname = basePath + requestUrl.pathname;
  target.search = requestUrl.search;
  return target;
}

function forwardResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of ['transfer-encoding', ...HOP_BY_HOP]) headers.delete(name);
  // Fetch decodes compressed bodies, so these headers no longer describe the body it returns.
  if (headers.has('content-encoding')) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  const hasBody = response.status !== 204 && response.status !== 304;
  return new Response(hasBody ? response.body : null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requestTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function clientInfo(url: URL): ClientInfo {
  const params = url.searchParams;
  return {
    version: params.get('version') || undefined,
    protocol: integer(params.get('protocol')),
    platform: integer(params.get('platform')),
    networkId: params.get('id') || undefined,
  };
}

function integer(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

type Observation = (status: number) => void;

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
