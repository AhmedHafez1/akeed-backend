/**
 * Transport-level retry policy shared by every BullMQ producer.
 *
 * Registered as `defaultJobOptions` on the Bull root module and spread by the
 * producers that need to add a `jobId` or `delay`. Keeping one definition means
 * webhook ingestion and verification automation cannot drift apart on how many
 * times a job is retried or how long failures are retained.
 */
export const DEFAULT_QUEUE_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 3_000 },
  removeOnComplete: { age: 7 * 24 * 3_600, count: 10_000 },
  removeOnFail: { age: 30 * 24 * 3_600, count: 50_000 },
};
