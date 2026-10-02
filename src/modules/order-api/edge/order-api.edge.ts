import { Logger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  json,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import {
  readOrderApiConfig,
  type OrderApiConfig,
} from '../../../shared/config/order-api.config';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import type { RequestWithIntegrationApiKey } from '../../integration-keys/integration-api-key.principal';
import {
  orderApiRequestState,
  sendOrderApiFailure,
  type OrderApiRequestState,
} from './order-api-request-state';
import {
  orderApiError,
  toOrderApiFailure,
  type OrderApiFailure,
} from './order-api.errors';

/** Everything under this path is the versioned server API. */
export const ORDER_API_MOUNT_PATH = '/api/v1';

const LOG_MODULE = 'OrderApi';

/**
 * The first thing an order API request meets (US-05-04).
 *
 * It settles the correlation ID, reads the body under the API's own size
 * limit and writes the one log line of the request when the response ends,
 * whatever the outcome. That line is the MVP audit trail: it names the
 * integration, the key prefix, the outcome code, the duration and the order,
 * and never the key, the body or anything a customer typed.
 */
export class OrderApiEdge {
  private readonly logger = new Logger(LOG_MODULE);
  private readonly parseBody: RequestHandler;

  constructor(config: Pick<OrderApiConfig, 'maxBodyBytes'>) {
    this.parseBody = json({
      limit: config.maxBodyBytes,
      // Every body is read as JSON under the limit, whatever its content
      // type, so a form-encoded body cannot reach the app-wide parser and its
      // larger limit.
      type: () => true,
    });
  }

  handle(request: Request, response: Response, next: NextFunction): void {
    const state = orderApiRequestState(request, response);
    response.once('finish', () => this.logRequest(request, response, state));
    void this.parseBody(request, response, (error?: unknown) => {
      if (error === undefined || error === null) return next();
      const failure = bodyFailureOf(error);
      // The rest of an oversized body is never read; the connection cannot be
      // reused for another request.
      if (failure.status === 413) response.setHeader('Connection', 'close');
      sendOrderApiFailure(response, state, failure);
    });
  }

  private logRequest(
    request: RequestWithIntegrationApiKey,
    response: Response,
    state: OrderApiRequestState,
  ): void {
    const principal = request.integrationApiKey;
    const httpStatus = response.statusCode;
    const context = {
      action: 'order-api-request',
      outcome: httpStatus < 400 ? ('success' as const) : ('failure' as const),
      requestId: state.correlationId,
      correlationId: state.correlationId,
      orgId: principal?.orgId,
      integrationId: principal?.integrationId,
      keyId: principal?.keyId,
      keyPrefix: principal?.prefix,
      httpStatus,
      resultCode: state.resultCode ?? `http_${httpStatus}`,
      errorCode: state.errorCode,
      durationMs: Date.now() - state.startedAt,
      orderId: state.orderId,
    };
    // A refusal is expected traffic; only a server fault is an error.
    if (httpStatus >= 500)
      this.logger.error(buildBackendLog(LOG_MODULE, context));
    else if (httpStatus >= 400)
      this.logger.warn(buildBackendLog(LOG_MODULE, context));
    else this.logger.log(buildBackendLog(LOG_MODULE, context));
  }
}

/**
 * Mounts the edge ahead of Nest's own body parser. Call it before the app is
 * initialised: a parser that runs later finds the body already read and
 * leaves it alone, so the API's limit is the one that applies.
 */
export function applyOrderApiEdge(app: INestApplication): void {
  const edge = new OrderApiEdge(readOrderApiConfig(app.get(ConfigService)));
  app.use(
    ORDER_API_MOUNT_PATH,
    (request: Request, response: Response, next: NextFunction) =>
      edge.handle(request, response, next),
  );
}

/** What the body parser refused, as the API's failure. */
function bodyFailureOf(error: unknown): OrderApiFailure {
  const details =
    error !== null && typeof error === 'object'
      ? (error as { type?: unknown; status?: unknown })
      : {};
  if (details.type === 'entity.too.large')
    return toOrderApiFailure(orderApiError('API_PAYLOAD_TOO_LARGE'));
  if (typeof details.status === 'number' && details.status < 500)
    return toOrderApiFailure(orderApiError('API_VALIDATION_FAILED'));
  return toOrderApiFailure(error);
}
