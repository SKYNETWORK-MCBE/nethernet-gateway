import type { ConnInfo } from '../types';

/**
 * Reads the client address Cloudflare sets in `CF-Connecting-IP`. Cloudflare overwrites the
 * header, so use this only when the gateway runs on Cloudflare Workers.
 */
export function getConnInfo(c: { readonly req: Request }): ConnInfo {
  return { remote: { address: c.req.headers.get('cf-connecting-ip') ?? undefined } };
}
