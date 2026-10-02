import { HttpException, HttpStatus } from '@nestjs/common';
import { databaseErrorCode } from '../../../shared/database/serializable-retry';

/**
 * The codes the API's protection layer answers with (US-05-04), beside the
 * `API_*` codes of the channel adapter and the key guard. Integrators switch
 * on them, so they are never renamed.
 */
export type OrderApiEdgeErrorCode =
  | 'API_RATE_LIMITED'
  | 'API_PAYLOAD_TOO_LARGE'
  | 'API_VALIDATION_FAILED'
  | 'API_REQUEST_REJECTED'
  | 'API_INTERNAL_ERROR';

const STATUS: Record<OrderApiEdgeErrorCode, HttpStatus> = {
  API_RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  API_PAYLOAD_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  API_VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  API_REQUEST_REJECTED: HttpStatus.BAD_REQUEST,
  API_INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,
};

const MESSAGES: Record<OrderApiEdgeErrorCode, string> = {
  API_RATE_LIMITED:
    'Too many requests. Wait for the Retry-After period, then retry with the same Idempotency-Key.',
  API_PAYLOAD_TOO_LARGE: 'The request body is too large.',
  API_VALIDATION_FAILED: 'The request body must be valid JSON.',
  API_REQUEST_REJECTED: 'The request was rejected.',
  API_INTERNAL_ERROR:
    'Something went wrong. Retry with the same Idempotency-Key, and quote the correlation ID to support if it keeps failing.',
};

export function orderApiError(code: OrderApiEdgeErrorCode): HttpException {
  return new HttpException(
    { statusCode: STATUS[code], message: MESSAGES[code], code },
    STATUS[code],
  );
}

/** What a refused request answers with, before the correlation ID is added. */
export interface OrderApiFailure {
  status: number;
  code: string;
  message: string;
  /** Per-field reasons; only a validation failure carries them. */
  fieldErrors?: Record<string, string>;
  /**
   * The internal reason of an unexpected failure (a PostgreSQL code or an
   * error class name). It goes to the log, never to the response.
   */
  errorCode?: string;
}

/** The one error body of the order API. */
export interface OrderApiErrorEnvelope {
  code: string;
  message: string;
  correlationId: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Reduces whatever a request threw to the API's failure shape.
 *
 * A coded exception was written for the caller: its code and message pass
 * through, which keeps the adapter's `API_*` codes and the E04.5 credit codes
 * unchanged. Anything else gets a fixed message, so SQL, stack traces, provider
 * text and other tenants' identifiers cannot reach the response.
 */
export function toOrderApiFailure(exception: unknown): OrderApiFailure {
  if (!(exception instanceof HttpException)) {
    return {
      ...failureOf('API_INTERNAL_ERROR'),
      errorCode:
        databaseErrorCode(exception) ??
        (exception instanceof Error ? exception.name : 'UnknownError'),
    };
  }
  const status = exception.getStatus();
  const response = exception.getResponse();
  const details =
    response !== null && typeof response === 'object'
      ? (response as Record<string, unknown>)
      : {};
  if (typeof details.code !== 'string' || details.code.length === 0) {
    return status >= 500
      ? { ...failureOf('API_INTERNAL_ERROR'), errorCode: `http_${status}` }
      : { ...failureOf('API_REQUEST_REJECTED'), status };
  }
  const fieldErrors =
    details.code === 'API_VALIDATION_FAILED'
      ? textFieldsOf(details.fieldErrors)
      : undefined;
  return {
    status,
    code: details.code,
    message:
      typeof details.message === 'string'
        ? details.message
        : MESSAGES[
            status >= 500 ? 'API_INTERNAL_ERROR' : 'API_REQUEST_REJECTED'
          ],
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

export function toOrderApiErrorEnvelope(
  failure: OrderApiFailure,
  correlationId: string,
): OrderApiErrorEnvelope {
  return {
    code: failure.code,
    message: failure.message,
    correlationId,
    ...(failure.fieldErrors ? { fieldErrors: failure.fieldErrors } : {}),
  };
}

function failureOf(code: OrderApiEdgeErrorCode): OrderApiFailure {
  return { status: STATUS[code], code, message: MESSAGES[code] };
}

function textFieldsOf(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const fields = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return fields.length > 0 ? Object.fromEntries(fields) : undefined;
}
