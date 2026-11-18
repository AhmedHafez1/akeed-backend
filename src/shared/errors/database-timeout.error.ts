export type DatabaseTimeoutScope = 'query' | 'transaction' | 'ping';

/**
 * The database did not answer within a client-side deadline. The statement's
 * outcome is unknown, exactly as after a dropped connection: a write may
 * still commit, so callers rely on their idempotency keys to retry.
 */
export class DatabaseTimeoutError extends Error {
  readonly code = 'DATABASE_TIMEOUT';

  constructor(
    readonly scope: DatabaseTimeoutScope,
    readonly timeoutMs: number,
  ) {
    super(`Database ${scope} did not finish within ${timeoutMs} ms`);
    this.name = 'DatabaseTimeoutError';
  }
}

/** Finds a timeout under the wrappers Drizzle puts around driver errors. */
export function findDatabaseTimeout(
  error: unknown,
): DatabaseTimeoutError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof DatabaseTimeoutError) return current;
    current =
      current instanceof Error ? (current as { cause?: unknown }).cause : null;
  }
  return undefined;
}
