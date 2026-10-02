import { randomUUID } from 'node:crypto';

/** The header a client may send and every order API response carries. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * What a client-supplied correlation ID may look like. Anything else could
 * carry log-forging characters, markup or customer data into the logs and the
 * response, so it is replaced rather than cleaned.
 */
export const SAFE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/** The client's correlation ID when it is safe to echo, otherwise a new one. */
export function resolveCorrelationId(header: unknown): string {
  const supplied: unknown = Array.isArray(header) ? header[0] : header;
  return typeof supplied === 'string' &&
    SAFE_CORRELATION_ID_PATTERN.test(supplied)
    ? supplied
    : randomUUID();
}
