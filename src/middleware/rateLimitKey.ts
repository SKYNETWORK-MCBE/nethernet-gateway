import { isIP } from '../ip';
import type { Awaitable, GatewayContext } from '../types';

/** Built-in source or a function that returns the value identifying a bucket. */
export type RateLimitKey<CTX extends GatewayContext = GatewayContext> =
  | 'ip'
  | 'global'
  | ((context: CTX) => Awaitable<string | undefined>);

// Not empty, so stores that reject an empty key accept it. IP buckets never take this form.
export const GLOBAL_KEY = 'global';

const KEYS = new Set(['ip', 'global']);

export function isRateLimitKey(key: unknown): boolean {
  return typeof key === 'function' || KEYS.has(key as string);
}

/** Resolves a rule's key to a bucket, or `undefined` to skip the rule for this request. */
export async function resolveKey<CTX extends GatewayContext>(
  key: RateLimitKey<CTX>,
  context: CTX,
): Promise<string | undefined> {
  if (key === 'global') return GLOBAL_KEY;
  if (key === 'ip') {
    // Without an address every client would share one bucket, so fail loudly instead.
    if (!context.remoteAddress) {
      throw new Error(
        'An ip rate-limit rule requires remoteAddress; set getConnInfo on the gateway',
      );
    }
    return ipBucketKey(context.remoteAddress);
  }

  const value = await key(context);
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError('A rate-limit key function must return a string or undefined');
  }
  return value;
}

function ipBucketKey(address: string): string {
  if (isIP(address) !== 6) return address;

  const [host, zone] = address.split('%', 2);
  const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  const [left, right = ''] = canonical.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups = [
    ...head,
    ...Array.from({ length: 8 - head.length - tail.length }, () => '0'),
    ...tail,
  ].map((group) => Number.parseInt(group, 16));

  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6];
    const low = groups[7];
    return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
  }

  const prefix = groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':');
  return `ipv6:${prefix}${zone ? `%${zone}` : ''}`;
}
