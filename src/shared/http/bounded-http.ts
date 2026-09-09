/**
 * Bounded outbound HTTP for provider calls.
 *
 * Two rules a payment adapter cannot do without and the codebase did not yet
 * have anywhere:
 *
 * - Every attempt has a deadline. An unbounded provider call holds a request
 *   thread until the socket gives up, and for a checkout that means the
 *   merchant waits with no answer while a local purchase row sits pending.
 * - Retries are opt-in per call, never a default. Retrying a request that may
 *   already have created something at the provider is how you get two
 *   payment intentions for one purchase.
 */

export interface RetryPolicy {
  /** Total attempts including the first. 1 means never retry. */
  attempts: number;
  /** Upper bound of the first backoff window, in milliseconds. */
  baseDelayMs: number;
  /** Ceiling for any single backoff window. */
  maxDelayMs: number;
  /** Give up once this much time has elapsed across all attempts. */
  totalDeadlineMs: number;
}

export const NO_RETRY: RetryPolicy = {
  attempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  totalDeadlineMs: 0,
};

/**
 * Full jitter: a uniform draw from `[0, min(base * 2^n, max))`.
 *
 * Equal-spaced retries from many workers re-collide on every wave; drawing the
 * whole window flattens that, and is cheaper than the alternatives to reason
 * about because there is no fixed component left to synchronize on.
 */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const window = Math.min(
    policy.baseDelayMs * 2 ** Math.max(attempt - 1, 0),
    policy.maxDelayMs,
  );
  return Math.floor(random() * window);
}

export class RetryableProviderError extends Error {}

export interface BoundedCallOptions {
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `call`, retrying only what it declares retryable.
 *
 * The caller decides retryability by throwing {@link RetryableProviderError};
 * anything else propagates on the first attempt. That keeps "is this safe to
 * repeat?" with the code that knows the provider's semantics rather than in a
 * generic status-code table.
 */
export async function boundedCall<T>(
  call: (attempt: number) => Promise<T>,
  options: BoundedCallOptions = {},
): Promise<T> {
  const policy = options.policy ?? NO_RETRY;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(policy.attempts, 1); attempt += 1) {
    try {
      return await call(attempt);
    } catch (error) {
      lastError = error;
      if (!(error instanceof RetryableProviderError)) throw error;
      if (attempt >= policy.attempts) break;
      const delay = backoffDelay(attempt, policy, options.random);
      if (now() - startedAt + delay >= policy.totalDeadlineMs) break;
      await sleep(delay);
    }
  }
  throw lastError;
}
