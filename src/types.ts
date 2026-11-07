import type { JWK } from 'jose';

export type Awaitable<T> = T | Promise<T>;

export interface NetherNetServerInfo {
  name: string;
  protocol: number;
  version: string;
  level: string;
  players: number;
  maxPlayers: number;
  gameType: number;
}

export interface NetherNetIdentity {
  xuid: string;
  playFabId: string;
  gamertag: string;
  cpk: JWK;
  claims: Readonly<Record<string, unknown>>;
}

/** Identity claims decoded without verifying the token or its binding to the SDP. */
export interface UntrustedNetherNetIdentity {
  readonly xuid: string;
  readonly playFabId: string;
  readonly gamertag: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

export type VerifyClientToken = (token: string) => Awaitable<NetherNetIdentity>;

/** An execution context that can extend the request lifetime, such as on Cloudflare Workers. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/** Connection details resolved by a runtime adapter's `getConnInfo`. */
export interface ConnInfo {
  readonly remote: {
    readonly address?: string | undefined;
  };
}

/** Resolves connection details from the runtime's request and bindings. */
export type GetConnInfo = (c: { readonly req: Request; readonly env: unknown }) => ConnInfo;

export interface NetherNetGatewayErrorEvent {
  readonly source: 'request' | 'middleware' | 'upstream' | 'listener';
  readonly error: unknown;
  readonly method: string;
  readonly url: string;
}

/**
 * Query parameters a client sends with a server information request (Minecraft 1.26.60 and later).
 * Older clients and some requests send none, and an absent or malformed value is `undefined`.
 * The values are client-supplied and may be forged.
 */
export interface ClientInfo {
  /** Game version, such as `1.26.60.30`. */
  readonly version: string | undefined;
  /** Network protocol version. */
  readonly protocol: number | undefined;
  /** Client build platform. */
  readonly platform: number | undefined;
  /** The client's Network ID, which its following join request uses. */
  readonly networkId: string | undefined;
}

/** Fields shared by the `info` and `join` events. Headers are a detached snapshot. */
export interface NetherNetGatewayRequestEvent {
  readonly url: string;
  readonly remoteAddress: string | undefined;
  readonly headers: Headers;
  /** Status of the final response sent to the client, after every middleware has run. */
  readonly status: number;
}

/** A server information request that was forwarded upstream. Headers are a detached snapshot. */
export interface NetherNetGatewayInfoEvent extends NetherNetGatewayRequestEvent {
  readonly client: ClientInfo;
}

/**
 * The verified identity of a join. `Verified` is `true` when the gateway has a `verifyClientToken`,
 * so the identity is always present, and `false` when it has none, so there is no identity at all.
 * `boolean` leaves it optional for code that works with either gateway.
 */
export type JoinIdentity<Verified extends boolean = boolean> = [Verified] extends [true]
  ? { readonly identity: NetherNetIdentity }
  : [Verified] extends [false]
    ? unknown
    : { readonly identity?: NetherNetIdentity | undefined };

/** A join event without its verified identity; see {@link NetherNetGatewayJoinEvent}. */
export interface NetherNetGatewayJoinEventBase extends NetherNetGatewayRequestEvent {
  readonly networkId: string;
  /** Client-supplied claims that may be forged. Never use these for authorization. */
  readonly untrustedIdentity: UntrustedNetherNetIdentity;
}

/** A validated join offer that was forwarded upstream. Headers are a detached snapshot. */
export type NetherNetGatewayJoinEvent<Verified extends boolean = boolean> =
  NetherNetGatewayJoinEventBase & JoinIdentity<Verified>;

export interface GatewayContext {
  readonly req: Request;
  readonly url: URL;
  /**
   * The peer address resolved by the gateway's `getConnInfo`, or `undefined` without one.
   * Use a custom key generator when running behind a trusted proxy.
   */
  readonly remoteAddress: string | undefined;
  /** The runtime-specific second `fetch` argument, such as bindings or server information. */
  readonly env: unknown;
  /** The runtime-specific third `fetch` argument, if the runtime passes one. */
  readonly executionCtx: ExecutionContext | undefined;
}

export interface ServerInfoContext extends GatewayContext {
  readonly client: ClientInfo;
}

/** A join context without its verified identity; see {@link JoinContext}. */
export interface JoinContextBase extends GatewayContext {
  readonly networkId: string;
  readonly offer: string;
  /** Client-supplied claims that may be forged. Never use these for authorization. */
  readonly untrustedIdentity: UntrustedNetherNetIdentity;
}

export type JoinContext<Verified extends boolean = boolean> = JoinContextBase &
  JoinIdentity<Verified>;

/** A middleware can pass a replacement request to change the request sent downstream. */
export type Next = (req?: Request) => Promise<Response>;

export type GatewayMiddleware<CTX extends GatewayContext = GatewayContext> = (
  c: CTX,
  next: Next,
) => Awaitable<Response>;
