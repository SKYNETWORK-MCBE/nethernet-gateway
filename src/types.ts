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

export interface NetherNetGatewayErrorEvent {
  readonly source: 'request' | 'middleware' | 'upstream' | 'response' | 'listener';
  readonly error: unknown;
  readonly method: string;
  readonly url: string;
}

/** An attempt to forward a server information request. Headers are a detached snapshot. */
export interface NetherNetGatewayInfoEvent {
  readonly url: string;
  readonly remoteAddress: string | undefined;
  readonly headers: Headers;
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
export interface NetherNetGatewayJoinEventBase extends NetherNetGatewayInfoEvent {
  readonly networkId: string;
  /** Client-supplied claims that may be forged. Never use these for authorization. */
  readonly untrustedIdentity: UntrustedNetherNetIdentity;
}

/** An attempt to forward a validated join offer. Headers are a detached snapshot. */
export type NetherNetGatewayJoinEvent<Verified extends boolean = boolean> =
  NetherNetGatewayJoinEventBase & JoinIdentity<Verified>;

export interface GatewayContext {
  readonly req: Request;
  readonly url: URL;
  /** The direct peer address. Use a custom key generator when running behind a trusted proxy. */
  readonly remoteAddress: string | undefined;
}

export interface ServerInfoContext extends GatewayContext {}

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
