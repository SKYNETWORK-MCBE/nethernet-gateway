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
  readonly source: 'request' | 'middleware' | 'upstream' | 'response';
  readonly error: unknown;
  readonly method: string;
  readonly url: string;
}

export interface GatewayContext {
  readonly req: Request;
  readonly url: URL;
  /** The direct peer address. Use a custom key generator when running behind a trusted proxy. */
  readonly remoteAddress: string | undefined;
}

export interface ServerInfoContext extends GatewayContext {}

export interface JoinContext extends GatewayContext {
  readonly networkId: string;
  readonly offer: string;
  /** Client-supplied claims that may be forged. Never use these for authorization. */
  readonly untrustedIdentity: UntrustedNetherNetIdentity;
  readonly identity: NetherNetIdentity | undefined;
}

/** A middleware can pass a replacement request to change the request sent downstream. */
export type Next = (req?: Request) => Promise<Response>;

export type GatewayMiddleware<CTX extends GatewayContext = GatewayContext> = (
  c: CTX,
  next: Next,
) => Awaitable<Response>;
