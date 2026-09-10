import {
  HttpException,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { tap, type Observable } from 'rxjs';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { databaseErrorCode } from '../../shared/database/serializable-retry';
import type { RequestWithAdmin } from './admin.types';
import { readRequestId } from './standalone-billing-operator.guard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * One structured line per staff billing read or write.
 *
 * It records only internal references -- the actor, the organization, the
 * dispatch or purchase reference, the request id -- and the outcome or error
 * code. Bodies are never read: staff reasons, provider evidence and message
 * ids stay in the audit row they belong to and out of the log stream.
 */
@Injectable()
export class StandaloneBillingLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('StandaloneBillingOperations');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithAdmin>();
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const orgId = params.orgId ?? body.orgId;
    const started = Date.now();
    const base = {
      action: `standalone-billing.${context.getHandler().name}`,
      userId: request.admin?.userId,
      requestId: readRequestId(request),
      ...(typeof orgId === 'string' && UUID.test(orgId) ? { orgId } : {}),
      ...(params.dispatchId && UUID.test(params.dispatchId)
        ? { dispatchId: params.dispatchId }
        : {}),
      ...(params.purchaseRef && REFERENCE.test(params.purchaseRef)
        ? { reference: params.purchaseRef }
        : {}),
    };
    return next.handle().pipe(
      tap({
        next: (value: unknown) => {
          const outcome =
            value && typeof value === 'object' && 'outcome' in value
              ? (value as { outcome: unknown }).outcome
              : undefined;
          this.logger.log(
            buildBackendLog('StandaloneBillingOperations', {
              ...base,
              outcome: 'success',
              durationMs: Date.now() - started,
              ...(typeof outcome === 'string' ? { resultCode: outcome } : {}),
            }),
          );
        },
        error: (error: unknown) => {
          const status =
            error instanceof HttpException ? error.getStatus() : 500;
          const failure = {
            ...base,
            outcome: 'failure' as const,
            durationMs: Date.now() - started,
            httpStatus: status,
            errorCode: errorCodeOf(error),
          };
          // A refusal is expected traffic; only a server fault is an error.
          if (status >= 500)
            this.logger.error(
              buildBackendLog('StandaloneBillingOperations', failure),
            );
          else
            this.logger.warn(
              buildBackendLog('StandaloneBillingOperations', failure),
            );
        },
      }),
    );
  }
}

export function errorCodeOf(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (
      response &&
      typeof response === 'object' &&
      typeof (response as { code?: unknown }).code === 'string'
    )
      return (response as { code: string }).code;
    return `http_${error.getStatus()}`;
  }
  return (
    databaseErrorCode(error) ??
    (error instanceof Error ? error.name : 'UnknownError')
  );
}
