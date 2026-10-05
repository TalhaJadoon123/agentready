/**
 * Tiny retry / backoff helpers. Every outbound request in AgentReady goes
 * through here so we never hammer a free-tier API into rate-limiting us.
 */

import { sleep } from './utils.js';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Extra multiplier per attempt (default 2 = exponential). */
  factor?: number;
  jitter?: boolean;
  /** Return false to fail fast without retrying. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

/** HTTP statuses worth retrying. 4xx generally are not (except 408/429). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 5_000;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? true;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('aborted');
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = opts.shouldRetry ? opts.shouldRetry(err, attempt) : true;
      if (!retryable || attempt === attempts) break;
      const exp = Math.min(max, base * factor ** (attempt - 1));
      const delay = jitter ? Math.round(exp * (0.5 + Math.random() * 0.5)) : exp;
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * `fetch` with a hard timeout, bounded retries and optional rate limiting.
 * Returns the Response regardless of status so callers can inspect 4xx.
 */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit & { timeoutMs?: number; retry?: RetryOptions } = {},
): Promise<Response> {
  const { timeoutMs = 15_000, retry, ...rest } = init;
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // Respect an outer signal.
      const onAbort = () => controller.abort();
      rest.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(input, { ...rest, signal: controller.signal });
        if (isRetryableStatus(res.status)) {
          const err = new Error(`HTTP ${res.status} ${res.statusText}`);
          (err as Error & { status?: number }).status = res.status;
          // Respect Retry-After when present.
          const ra = res.headers.get('retry-after');
          if (ra) {
            const secs = Number.parseInt(ra, 10);
            if (Number.isFinite(secs)) await sleep(Math.min(20_000, secs * 1000));
          }
          throw err;
        }
        return res;
      } finally {
        clearTimeout(timer);
        rest.signal?.removeEventListener('abort', onAbort);
      }
    },
    {
      attempts: 3,
      baseDelayMs: 300,
      shouldRetry: (err) => {
        const status = (err as { status?: number } | null)?.status;
        return typeof status === 'number' ? isRetryableStatus(status) : true;
      },
      ...retry,
      signal: rest.signal ?? undefined,
    },
  );
}

/**
 * Token-bucket rate limiter. Applied per outbound host so a scan of 50 pages
 * does not trip a free-tier API's burst limit.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
      this.lastRefill = now;
    }
  }

  async take(count = 1): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      const needed = count - this.tokens;
      const waitMs = Math.max(10, Math.ceil((needed / this.refillPerSec) * 1000));
      await sleep(waitMs);
    }
  }
}

/** Shared limiter for outbound registry/API calls. */
export const registryLimiter = new RateLimiter(5, 5);