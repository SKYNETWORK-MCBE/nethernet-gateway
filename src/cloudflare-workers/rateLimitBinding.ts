import { isRateLimitKey, type RateLimitKey, resolveKey } from '../middleware/rateLimitKey';
import type { GatewayContext, GatewayMiddleware } from '../types';

/** The part of a Workers Rate Limiting binding (`RateLimit`) the middleware calls. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitBindingRule<CTX extends GatewayContext = GatewayContext> {
  /** Returns the binding to count against, usually from `c.env`. */
  limiter: (context: CTX) => RateLimitBinding;
  /** Built-in source or a function that returns the value identifying a bucket. */
  key: RateLimitKey<CTX>;
}

export interface RateLimitBindingOptions<CTX extends GatewayContext = GatewayContext> {
  /** Checked in order; the first rule without capacity rejects the request. */
  rules: readonly RateLimitBindingRule<CTX>[];
  /** Seconds sent in `Retry-After` with a `429`, such as the binding's `period`. */
  retryAfter?: number;
}

/**
 * Limits requests with Workers Rate Limiting bindings. The limit and period are set on each
 * binding in the Wrangler configuration. Counts are approximate and kept per Cloudflare location.
 */
export function rateLimitBinding<CTX extends GatewayContext = GatewayContext>(
  options: RateLimitBindingOptions<CTX>,
): GatewayMiddleware<CTX> {
  const { rules, retryAfter } = options;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new TypeError('rules must contain at least one rule');
  }
  rules.forEach((rule, index) => {
    if (typeof rule !== 'object' || rule === null) {
      throw new TypeError(`rules[${index}] must be a rule object`);
    }
    if (typeof rule.limiter !== 'function') {
      throw new TypeError(`rules[${index}].limiter must be a function`);
    }
    if (!isRateLimitKey(rule.key)) {
      throw new TypeError(`rules[${index}].key must be "ip", "global", or a function`);
    }
  });
  if (retryAfter !== undefined && (!Number.isSafeInteger(retryAfter) || retryAfter < 0)) {
    throw new TypeError('retryAfter must be a non-negative safe integer');
  }

  return async (context, next) => {
    // Resolve every key first, so an invalid key fails before any binding counts the request.
    const resolved: Array<{ rule: RateLimitBindingRule<CTX>; key: string }> = [];
    for (const rule of rules) {
      const key = await resolveKey(rule.key, context);
      if (key !== undefined) resolved.push({ rule, key });
    }

    // A call counts the request, so stop at the first rule that rejects it.
    for (const { rule, key } of resolved) {
      const { success } = await rule.limiter(context).limit({ key });
      if (!success) {
        const headers =
          retryAfter === undefined ? undefined : { 'Retry-After': String(retryAfter) };
        return new Response('Too Many Requests', { status: 429, headers });
      }
    }
    return next();
  };
}
