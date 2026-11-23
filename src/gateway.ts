import { Emitter } from './emitter';
import { InvalidRequestBodyError, RequestTooLargeError } from './errors';
import { extractUntrustedClientIdentity, verifyClientIdentity } from './identity';
import { readBody } from './http';
import type {
  Awaitable,
  BindingsOf,
  ClientInfo,
  ExecutionContext,
  GetConnInfo,
  GatewayEnv,
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

export interface NetherNetGatewayEvents<
  E extends GatewayEnv = GatewayEnv,
  Verified extends boolean = boolean,
> {
  requestError: [event: NetherNetGatewayErrorEvent<E>];
  info: [event: NetherNetGatewayInfoEvent<E>];
  join: [event: NetherNetGatewayJoinEvent<E, Verified>];
}

/** How long the upstream may take to respond before the gateway answers `504`. */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

export interface NetherNetGatewayOptions<E extends GatewayEnv = GatewayEnv> {
  /** The upstream base URL, or a function that chooses one for each request. */
  upstream: string | ((c: GatewayContext<E>) => Awaitable<string>);
  /**
   * Milliseconds the upstream may take to send its whole response before the gateway answers
   * `504 Gateway Timeout`. Defaults to 10 seconds.
   */
  upstreamTimeout?: number;
  /**
   * Sends the request to the upstream in place of the global `fetch`, for an upstream reached
   * through a binding, as in `(request, c) => c.env.BDS.fetch(request)`. The request targets
   * `upstream` and carries the `upstreamTimeout` signal.
   */
  fetch?: (request: Request, c: GatewayContext<E>) => Awaitable<Response>;
  verifyClientToken?: VerifyClientToken;
  /**
   * Resolves `remoteAddress` from the request and `env`. Pass the `getConnInfo` exported by the
   * subpath for your runtime, such as `nethernet-gateway/bun`.
   */
  getConnInfo?: GetConnInfo;
}

/**
 * Creates a gateway. Supply `Bindings` to type `c.env`, as in
 * `new NetherNetGateway<{ Bindings: Env }>(options)`. Whether `c.identity` is always present follows
 * from `verifyClientToken`, even when `Bindings` is given.
 */
export interface NetherNetGatewayConstructor {
  new <E extends GatewayEnv = GatewayEnv>(
    options: NetherNetGatewayOptions<E> & { verifyClientToken: VerifyClientToken },
  ): NetherNetGateway<E, true>;
  new <E extends GatewayEnv = GatewayEnv>(
    options: NetherNetGatewayOptions<E> & { verifyClientToken?: undefined },
  ): NetherNetGateway<E, false>;
  new <E extends GatewayEnv = GatewayEnv>(
    options: NetherNetGatewayOptions<E>,
  ): NetherNetGateway<E, boolean>;
  readonly prototype: NetherNetGateway;
}

class Gateway<E extends GatewayEnv, out Verified extends boolean> extends Emitter<
  NetherNetGatewayEvents<E, Verified>
> {
  readonly options: Readonly<NetherNetGatewayOptions<E>>;

  private readonly infoMiddlewares: GatewayMiddleware<ServerInfoContext>[] = [];
  private readonly joinMiddlewares: GatewayMiddleware<JoinContext>[] = [];
  private readonly requestMiddlewares: GatewayMiddleware[] = [];

  constructor(options: NetherNetGatewayOptions<E>) {
    super();
    this.options = Object.freeze({ ...options });
    this.validateOptions();
  }

  use(middleware: GatewayMiddleware<GatewayContext<E>>): this;
  use(selector: 'info', middleware: GatewayMiddleware<ServerInfoContext<E>>): this;
  use(selector: 'join', middleware: GatewayMiddleware<JoinContext<E, Verified>>): this;
  use(
    selector: 'info' | 'join' | GatewayMiddleware<GatewayContext<E>>,
    middleware?:
      | GatewayMiddleware<ServerInfoContext<E>>
      | GatewayMiddleware<JoinContext<E, Verified>>,
  ): this {
    // The context's env is whatever the runtime passed; `E` only describes it to middleware.
    if (typeof selector === 'function') {
      this.requestMiddlewares.push(selector as GatewayMiddleware);
      return this;
    }

    if (typeof middleware !== 'function') {
      throw new TypeError(`A middleware function is required for ${selector}`);
    }

    if (selector === 'info') {
      this.infoMiddlewares.push(middleware as GatewayMiddleware<ServerInfoContext>);
    } else if (selector === 'join') {
      this.joinMiddlewares.push(middleware as unknown as GatewayMiddleware<JoinContext>);
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
    env?: BindingsOf<E>,
    executionCtx?: ExecutionContext,
  ): Promise<Response> => {
    const { method, url } = request;
    if (method === 'CONNECT' || method === 'TRACE' || method === 'TRACK') {
      return new Response('Not Found', { status: 404 });
    }

    const runtime = { env, executionCtx };
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
      this.emitRequestError('request', error, method, url, runtime);
      return new Response('Internal Server Error', { status: 500 });
    }

    try {
      return await runMiddleware(this.requestMiddlewares, context, async (requestContext) => {
        try {
          return await this.dispatch(requestContext);
        } catch (error) {
          this.emitRequestError('request', error, method, url, runtime);
          return new Response('Internal Server Error', { status: 500 });
        }
      });
    } catch (error) {
      this.emitRequestError('middleware', error, method, url, runtime);
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
          ? await this.options.upstream(context as GatewayContext<E>)
          : this.options.upstream;
      const target = upstreamUrl(upstream, new URL(request.url));

      const headers = new Headers(request.headers);
      // The runtime derives these from the target URL and the buffered body.
      for (const name of ['host', 'content-length', 'transfer-encoding', ...HOP_BY_HOP]) {
        headers.delete(name);
      }
      // BDS requires a content length and does not read a chunked request body, so buffer it.
      const body = request.body ? await request.arrayBuffer() : undefined;

      const signal = AbortSignal.timeout(
        this.options.upstreamTimeout ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
      );
      const init = { method: request.method, headers, body, redirect: 'manual', signal } as const;
      const send = this.options.fetch;
      const response = send
        ? // A custom fetch may ignore the signal, so the timeout is enforced here as well.
          await withTimeout(send(new Request(target, init), context as GatewayContext<E>), signal)
        : await fetch(target, init);
      if (!(response instanceof Response)) {
        throw new TypeError('The fetch option must return a Response');
      }
      // Buffer the small signaling response so the timeout covers its body as well.
      return forwardResponse(response, await withTimeout(response.arrayBuffer(), signal));
    } catch (error) {
      this.emitRequestError('upstream', error, request.method, request.url, context);
      return isTimeout(error)
        ? new Response('Gateway Timeout', { status: 504 })
        : new Response('Bad Gateway', { status: 502 });
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
      this.emitRequestError('middleware', error, context.req.method, context.req.url, context);
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
      env: context.env,
      executionCtx: context.executionCtx,
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
          (this as Emitter<NetherNetGatewayEvents>).emit('info', {
            ...common,
            status,
            client: (context as ServerInfoContext).client,
          });
        }
      } catch (error) {
        try {
          this.emitRequestError('listener', error, context.req.method, url, context);
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
    runtime: { env: unknown; executionCtx: ExecutionContext | undefined },
  ): void {
    (this as Emitter<NetherNetGatewayEvents>).emit('requestError', {
      source,
      error,
      method,
      url: requestTarget(url),
      env: runtime.env,
      executionCtx: runtime.executionCtx,
    });
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

    const send = this.options.fetch;
    if (send !== undefined && typeof send !== 'function') {
      throw new TypeError('fetch must be a function');
    }

    const timeout = this.options.upstreamTimeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      throw new TypeError('upstreamTimeout must be a positive finite number');
    }
  }
}

export type NetherNetGateway<
  E extends GatewayEnv = GatewayEnv,
  Verified extends boolean = boolean,
> = Gateway<E, Verified>;
export const NetherNetGateway = Gateway as NetherNetGatewayConstructor;

// Runtime servers such as Cloudflare Workers pass immutable headers. Copy from the URL rather than
// the Request so the copy does not follow its signal, which some runtimes abort once they respond.
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

// Rejects with the signal's reason once it aborts, leaving the pending work to the runtime.
async function withTimeout<T>(work: Awaitable<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason as Error);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function forwardResponse(response: Response, body: ArrayBuffer): Response {
  const headers = new Headers(response.headers);
  for (const name of ['transfer-encoding', ...HOP_BY_HOP]) headers.delete(name);
  // Fetch decodes compressed bodies, so these headers no longer describe the body it returns.
  if (headers.has('content-encoding')) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  const hasBody = response.status !== 204 && response.status !== 304;
  return new Response(hasBody ? body : null, {
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
