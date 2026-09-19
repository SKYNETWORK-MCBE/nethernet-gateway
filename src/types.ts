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
export type Next = () => Promise<Response>;
export type GatewayMiddleware<Context extends GatewayContext> = (
  context: Context,
  next: Next,
) => Awaitable<Response>;
