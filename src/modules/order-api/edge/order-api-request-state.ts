import type { Request, Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
} from '../../../shared/http/correlation-id';
import {
  toOrderApiErrorEnvelope,
  type OrderApiFailure,
} from './order-api.errors';

/** What the request log line needs to know about one API request. */
export interface OrderApiRequestState {
  correlationId: string;
  startedAt: number;
  /** `accepted`, `duplicate` or the error code the caller was given. */
  resultCode?: string;
  /** Internal reason of an unexpected failure; log only. */
  errorCode?: string;
  orderId?: string;
}

const STATE_KEY = 'orderApiRequest';

/**
 * The state of this request, created on first use.
 *
 * Creating it settles the correlation ID: a safe client value is kept, any
 * other is replaced. The ID is set on the response and written over the
 * request's `x-request-id`, which the security middleware and the key guard
 * already echo and log, so every line about the request carries one ID.
 */
export function orderApiRequestState(
  request: Request,
  response: Response,
): OrderApiRequestState {
  const locals = response.locals as Record<string, unknown>;
  const existing = locals[STATE_KEY] as OrderApiRequestState | undefined;
  if (existing) return existing;
  const state: OrderApiRequestState = {
    correlationId: resolveCorrelationId(request.headers[CORRELATION_ID_HEADER]),
    startedAt: Date.now(),
  };
  locals[STATE_KEY] = state;
  request.headers['x-request-id'] = state.correlationId;
  response.setHeader('X-Correlation-Id', state.correlationId);
  response.setHeader('X-Request-Id', state.correlationId);
  return state;
}

/** Answers a refused request with the one error envelope and records why. */
export function sendOrderApiFailure(
  response: Response,
  state: OrderApiRequestState,
  failure: OrderApiFailure,
): void {
  state.resultCode = failure.code;
  state.errorCode = failure.errorCode;
  response
    .status(failure.status)
    .json(toOrderApiErrorEnvelope(failure, state.correlationId));
}
