import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isStandaloneBillingOperator,
  readStandaloneBillingOperationsConfig,
} from '../../shared/config/standalone-billing-operations.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type { RequestWithAdmin } from './admin.types';
import { STAFF_BILLING_ERROR_CODES } from './standalone-billing-operations.types';

/**
 * Admits a Standalone billing write only for a named operator.
 *
 * It is a method guard on purpose: Nest runs the controller's
 * `AdminAccessGuard` first, so by the time this runs the staff role, the AAL2
 * requirement and the control-tower flag have already been enforced and
 * audited. This adds the narrower switch on top rather than replacing any of
 * them.
 */
@Injectable()
export class StandaloneBillingOperatorGuard implements CanActivate {
  private readonly logger = new Logger(StandaloneBillingOperatorGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithAdmin>();
    const operations = readStandaloneBillingOperationsConfig(this.config);
    const code = !operations.enabled
      ? STAFF_BILLING_ERROR_CODES.operationsDisabled
      : !request.admin?.userId ||
          !isStandaloneBillingOperator(operations, request.admin.userId)
        ? STAFF_BILLING_ERROR_CODES.operatorRequired
        : null;
    if (!code) return true;
    this.logger.warn(
      buildBackendLog(StandaloneBillingOperatorGuard.name, {
        action: 'standalone-billing-operator-check',
        outcome: 'failure',
        userId: request.admin?.userId,
        requestId: readRequestId(request),
        route: `${request.method} ${request.path}`,
        errorCode: code,
      }),
    );
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message:
        code === STAFF_BILLING_ERROR_CODES.operationsDisabled
          ? 'Standalone billing operations are disabled.'
          : 'A named Standalone billing operator is required.',
      code,
    });
  }
}

export function readRequestId(request: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const value = request.headers['x-request-id'];
  const id = Array.isArray(value) ? value[0] : value;
  // Echoed into logs and audit rows, so only a bounded, printable token.
  return id && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : undefined;
}
