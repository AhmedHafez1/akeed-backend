/**
 * Ingestion outcomes a channel must report to its caller.
 *
 * Deliberately not HTTP exceptions: each channel owns its stable error codes
 * (`MANUAL_ORDER_*`, `IMPORT_*`, later the API's), and a batch import reports
 * these per row rather than as a response. The channel adapter maps them.
 */

/** The idempotency key was already used with different order content. */
export class StandaloneIngestionConflictError extends Error {
  constructor() {
    super('The idempotency key was already used with different order data');
    this.name = StandaloneIngestionConflictError.name;
  }
}

/** The order could not be durably accepted; nothing was committed. Retry safely. */
export class StandaloneIngestionAcceptanceError extends Error {
  constructor() {
    super('The order could not be durably accepted');
    this.name = StandaloneIngestionAcceptanceError.name;
  }
}

/**
 * The order and its event are committed but the verification was not queued.
 * Retrying with the same key replays the committed event and re-dispatches it.
 */
export class StandaloneIngestionDispatchError extends Error {
  constructor() {
    super('The order was saved but its verification could not be queued');
    this.name = StandaloneIngestionDispatchError.name;
  }
}
