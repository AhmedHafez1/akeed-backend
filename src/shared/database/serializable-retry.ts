/**
 * Serialization-failure retry for transactions that must be atomic.
 *
 * PostgreSQL reports a serializable conflict (40001) or a deadlock (40P01) by
 * aborting one transaction, and the correct response to both is to run the
 * whole thing again -- nothing was committed, so a retry is a clean first
 * attempt rather than a partial repeat. Every other error propagates.
 */

const RETRYABLE = new Set(['40001', '40P01']);

/** Walks the `cause` chain, because drivers nest the original error. */
export function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  return typeof candidate.code === 'string'
    ? candidate.code
    : databaseErrorCode(candidate.cause);
}

export function isSerializationFailure(error: unknown): boolean {
  return RETRYABLE.has(databaseErrorCode(error) ?? '');
}

/**
 * Runs `work`, retrying only a serialization failure or a deadlock.
 *
 * `attempts` is small on purpose: a conflict that survives three attempts is
 * contention worth surfacing, not worth grinding at inside a provider callback
 * the provider will itself retry.
 */
export async function withSerializableRetry<T>(
  work: (attempt: number) => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      if (attempt >= attempts || !isSerializationFailure(error)) throw error;
    }
  }
}
