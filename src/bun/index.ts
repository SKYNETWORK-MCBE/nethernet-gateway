import type { ConnInfo } from '../types';

/** The part of a `Bun.Server` that Bun passes as the second `fetch` argument. */
export interface BunServerLike {
  requestIP(request: Request): { address: string } | null;
}

/** Reads the peer address from the `Bun.Server` that `Bun.serve` passes as `env`. */
export function getConnInfo(c: { readonly req: Request; readonly env: unknown }): ConnInfo {
  const server = c.env as Partial<BunServerLike> | undefined;
  return { remote: { address: server?.requestIP?.(c.req)?.address } };
}
