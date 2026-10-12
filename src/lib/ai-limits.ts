/**
 * Abuse and cost controls for the AI server functions.
 *
 * A note on why auth alone is not the fix here.
 *
 * The obvious patch is `.middleware([authMiddleware])`, and that is applied
 * too. But in this app's shipped configuration `VITE_AUTH_ENABLED` is false,
 * and in that mode the auth middleware resolves a shared development user
 * rather than rejecting anonymous callers. So auth middleware alone would look
 * like a fix while leaving an unauthenticated, key-spending endpoint exactly as
 * exposed as before. The controls that actually bound the damage are the ones
 * in this file: a hard ceiling on request size, and a rate limit keyed on
 * whoever the caller resolves to.
 *
 * This is in-process and resets on restart. It is sized to stop a script from
 * turning a public demo into someone else's xAI invoice, not to survive a
 * distributed attack. A deployment that matters wants a shared store and a
 * per-account quota upstream of this.
 */

/** Requests allowed per caller per window. */
const LIMIT = 12;
/** Window length in milliseconds. */
const WINDOW_MS = 60_000;
/** Safety valve so the map cannot grow without bound under key churn. */
const MAX_TRACKED_CALLERS = 5_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      `Too many analysis requests. Try again in ${retryAfterSeconds}s. This endpoint spends a model API budget, so it is rate limited per caller.`,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function sweep(now: number) {
  if (buckets.size < MAX_TRACKED_CALLERS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Still full of live buckets: drop the oldest rather than grow forever.
  if (buckets.size >= MAX_TRACKED_CALLERS) {
    const oldest = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)[0];
    if (oldest) buckets.delete(oldest[0]);
  }
}

/**
 * Consume one unit of quota for `callerKey`.
 * @throws RateLimitError when the caller is over budget for the window.
 */
export function consumeQuota(callerKey: string): void {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(callerKey);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(callerKey, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  if (bucket.count >= LIMIT) {
    throw new RateLimitError(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
  }
  bucket.count += 1;
}

/** Test hook. Never called by application code. */
export function resetQuota(): void {
  buckets.clear();
}

export const AI_LIMITS = {
  /** A thesis is a sentence or two of intent, not a document. */
  thesis: 1_000,
  /** Company descriptions come from the registry; this is headroom, not an invitation. */
  about: 2_000,
  /** The registry carries fewer than 100 assets. */
  symbols: 120,
  /** A desk has a portfolio, not a dataset. */
  holdings: 60,
  /** Short free-text fields: symbol, name, sector, language tag. */
  short: 64,
  /** Session labels rendered into the prompt. */
  label: 120,
} as const;
