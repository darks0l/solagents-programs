/**
 * Simple in-memory rate limiter per agent or IP.
 * Configurable per-route.
 */

const buckets = new Map();

// Cleanup every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > bucket.windowMs * 2) {
      buckets.delete(key);
    }
  }
}, 60_000);

/**
 * Create a rate limit hook.
 * @param {{ max: number, windowMs: number, keyFn?: (req) => string }} opts
 */
export function rateLimit({ max = 60, windowMs = 60_000, keyFn } = {}) {
  return async (request, reply) => {
    const key = keyFn ? keyFn(request) : (request.agent?.id || request.ip);
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { count: 0, windowStart: now, windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    reply.header('X-RateLimit-Limit', max);
    reply.header('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
    reply.header('X-RateLimit-Reset', Math.ceil((bucket.windowStart + windowMs) / 1000));

    if (bucket.count > max) {
      return reply.code(429).send({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((bucket.windowStart + windowMs - now) / 1000),
      });
    }
  };
}
