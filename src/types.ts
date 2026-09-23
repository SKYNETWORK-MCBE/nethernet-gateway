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
  cpk: JWK;
  claims: Readonly<Record<string, unknown>>;
  playFabId?: string;
  uuid?: string;
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
  readonly identity?: NetherNetIdentity;
}

/** A middleware can pass a replacement request to change the request sent downstream. */
export type Next = (req?: Request) => Promise<Response>;

export type GatewayMiddleware<CTX extends GatewayContext = GatewayContext> = (
  c: CTX,
  next: Next,
) => Awaitable<Response>;
