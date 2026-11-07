import type { ConnInfo } from '../types';

/** The part of `Deno.ServeHandlerInfo` that `Deno.serve` passes as the second argument. */
export interface DenoServeHandlerInfoLike {
  remoteAddr: { hostname?: string };
}

/** Reads the peer address from the `Deno.ServeHandlerInfo` that `Deno.serve` passes as `env`. */
export function getConnInfo(c: { readonly env: unknown }): ConnInfo {
  const info = c.env as Partial<DenoServeHandlerInfoLike> | undefined;
  return { remote: { address: info?.remoteAddr?.hostname } };
}
