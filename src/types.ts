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

export interface ServerInfoContext {
  readonly request: Request;
}

export interface JoinContext {
  readonly request: Request;
  readonly networkId: string;
  readonly offer: string;
  readonly identity?: NetherNetIdentity;
}

export type GatewayContext = ServerInfoContext | JoinContext;
// A join middleware can pass a replacement request to change the offer sent upstream.
export type Next = (request?: Request) => Promise<Response>;
export type GatewayMiddleware<Context extends GatewayContext> = (
  context: Context,
  next: Next,
) => Awaitable<Response>;
