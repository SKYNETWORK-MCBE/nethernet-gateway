import { isIP } from 'node:net';
import type { Awaitable, GatewayContext, GatewayMiddleware } from '../types';

export type RateLimitKey<CTX extends GatewayContext = GatewayContext> =
  | 'ip'
  | 'global'
  | ((context: CTX) => Awaitable<string | undefined>);

export interface RateLimitRule<CTX extends GatewayContext = GatewayContext> {
  /** Built-in source or a function that returns the value identifying a bucket. */
  key: RateLimitKey<CTX>;
  /** Maximum requests allowed for this rule during a window. */
  limit: number;
}

export interface RateLimitOptions<CTX extends GatewayContext = GatewayContext> {
  /** Length of the sliding rate-limit window in milliseconds. */
  windowMs: number;
  /** Every applicable rule must have capacity before a request is passed downstream. */
  rules: readonly RateLimitRule<CTX>[];
}

interface RateLimitEntry {
  timestamps: number[];
}

interface NormalizedRule<CTX extends GatewayContext> extends RateLimitRule<CTX> {
  entries: Map<string, RateLimitEntry>;
}

interface RateLimitState {
  limit: number;
  remaining: number;
  resetAt: number;
}

function createRateLimit<CTX extends GatewayContext = GatewayContext>(
  options: RateLimitOptions<CTX>,
): GatewayMiddleware<CTX> {
  const { windowMs } = options;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('windowMs must be a positive finite number');
  }
  if (!Array.isArray(options.rules) || options.rules.length === 0) {
    throw new TypeError('rules must contain at least one rule');
  }

  const rules: NormalizedRule<CTX>[] = options.rules.map((rule, index) => {
    if (typeof rule !== 'object' || rule === null) {
      throw new TypeError(`rules[${index}] must be a rule object`);
    }
    if (!Number.isSafeInteger(rule.limit) || rule.limit <= 0) {
      throw new TypeError(`rules[${index}].limit must be a positive safe integer`);
    }
    if (rule.key !== 'ip' && rule.key !== 'global' && typeof rule.key !== 'function') {
      throw new TypeError(`rules[${index}].key must be "ip", "global", or a function`);
    }
    return { ...rule, entries: new Map() };
  });
  let nextSweepAt = 0;

  return async (context, next) => {
    const resolved: Array<{ rule: NormalizedRule<CTX>; key: string }> = [];
    for (const rule of rules) {
      const key = await resolveKey(rule.key, context);
      if (key !== undefined) resolved.push({ rule, key });
    }

    const now = Date.now();
    if (now >= nextSweepAt) {
      for (const rule of rules) {
        for (const [storedKey, entry] of rule.entries) {
          discardExpired(entry.timestamps, now - windowMs);
          if (entry.timestamps.length === 0) rule.entries.delete(storedKey);
        }
      }
      nextSweepAt = now + windowMs;
    }

    const counters: Array<{
      rule: NormalizedRule<CTX>;
      key: string;
      entry: RateLimitEntry;
    }> = [];
    for (const { rule, key } of resolved) {
      let entry = rule.entries.get(key);
      if (!entry) {
        entry = { timestamps: [] };
      }
      counters.push({ rule, key, entry });
    }

    if (counters.length === 0) return next();

    for (const { entry } of counters) discardExpired(entry.timestamps, now - windowMs);

    const blocked = counters
      .filter(({ entry, rule }) => entry.timestamps.length >= rule.limit)
      .map(({ entry, rule }) => state(entry, rule.limit, windowMs));
    if (blocked.length > 0) {
      const selected = blocked.reduce((latest, item) =>
        item.resetAt > latest.resetAt ? item : latest,
      );
      const headers = rateLimitHeaders(selected, now);
      headers.set('Retry-After', headers.get('RateLimit-Reset')!);
      return new Response('Too Many Requests', { status: 429, headers });
    }

    for (const { entry } of counters) entry.timestamps.push(now);
    for (const { rule, key, entry } of counters) rule.entries.set(key, entry);
    const selected = counters
      .map(({ entry, rule }) => state(entry, rule.limit, windowMs))
      .reduce((closest, item) =>
        item.remaining / item.limit < closest.remaining / closest.limit ? item : closest,
      );
    const headers = rateLimitHeaders(selected, now);
    return addHeaders(await next(), headers);
  };
}

function ipRule(limit: number): RateLimitRule {
  return { key: 'ip', limit };
}

function globalRule(limit: number): RateLimitRule {
  return { key: 'global', limit };
}

function customRule<CTX extends GatewayContext = GatewayContext>(
  limit: number,
  key: (context: CTX) => Awaitable<string | undefined>,
): RateLimitRule<CTX> {
  return { key, limit };
}

export const rateLimit = Object.assign(createRateLimit, {
  ip: ipRule,
  global: globalRule,
  custom: customRule,
});

async function resolveKey<CTX extends GatewayContext>(
  key: RateLimitKey<CTX>,
  context: CTX,
): Promise<string | undefined> {
  if (key === 'global') return '';
  if (key === 'ip') return ipBucketKey(context.remoteAddress);

  const value = await key(context);
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError('A rate-limit key function must return a string or undefined');
  }
  return value;
}

function ipBucketKey(address: string | undefined): string {
  if (!address || isIP(address) !== 6) return address ?? '';

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

function state(entry: RateLimitEntry, limit: number, windowMs: number): RateLimitState {
  return {
    limit,
    remaining: Math.max(0, limit - entry.timestamps.length),
    resetAt: entry.timestamps[0] + windowMs,
  };
}

function discardExpired(timestamps: number[], cutoff: number): void {
  let expired = 0;
  while (expired < timestamps.length && timestamps[expired] <= cutoff) expired += 1;
  if (expired > 0) timestamps.splice(0, expired);
}

function rateLimitHeaders(state: RateLimitState, now: number): Headers {
  const resetSeconds = Math.max(0, Math.ceil((state.resetAt - now) / 1000));
  return new Headers({
    'RateLimit-Limit': String(state.limit),
    'RateLimit-Remaining': String(state.remaining),
    'RateLimit-Reset': String(resetSeconds),
  });
}

function addHeaders(response: Response, additions: Headers): Response {
  if (response.status < 200) return response;

  const headers = new Headers(response.headers);
  additions.forEach((value, name) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
