import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import {
  isStandaloneBillingOperator,
  readStandaloneBillingOperationsConfig,
} from '../../shared/config/standalone-billing-operations.config';
import { balanceState } from './standalone-billing-operations.policy';
import { StandaloneBillingOperationsRepository } from './standalone-billing-operations.repository';
import {
  STAFF_BILLING_ERROR_CODES,
  type OperationsAccess,
  type ReconciliationReport,
  type StaffBillingErrorCode,
} from './standalone-billing-operations.types';

export function staffBillingError(
  Exception: typeof ConflictException | typeof NotFoundException,
  code: StaffBillingErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new Exception({ message, code, ...details });
}

/**
 * Staff inspection and reconciliation of one Standalone credit account.
 *
 * Nothing here trusts a balance from the browser: every before/after figure is
 * read from locked rows, and every write names the organization it acts on so
 * a purchase, dispatch or reservation from another tenant cannot be paired
 * with it.
 */
@Injectable()
export class StandaloneBillingOperationsService {
  constructor(
    private readonly repository: StandaloneBillingOperationsRepository,
    private readonly config: ConfigService,
  ) {}

  access(userId: string): OperationsAccess {
    const operations = readStandaloneBillingOperationsConfig(this.config);
    return {
      enabled: operations.enabled,
      operator: isStandaloneBillingOperator(operations, userId),
    };
  }

  async accountDetail(userId: string, orgId: string) {
    const detail = await this.repository.readDetail(orgId);
    if (!detail)
      staffBillingError(
        NotFoundException,
        STAFF_BILLING_ERROR_CODES.accountNotFound,
        'Organization not found.',
      );
    const { lowBalanceThreshold } = readStandaloneCreditBillingConfig(
      this.config,
    );
    const account = detail.account;
    const reconciliation = detail.reconciliation ?? null;
    return {
      organization: detail.organization,
      account: account
        ? {
            status: account.status,
            postedBalance: account.postedBalance,
            heldCredits: account.heldCredits,
            availableCredits: Math.max(
              account.postedBalance - account.heldCredits,
              0,
            ),
            debtCredits: Math.max(-account.postedBalance, 0),
            balanceState: balanceState(account, lowBalanceThreshold),
            version: account.version,
            approvedAt: account.approvedAt,
            updatedAt: account.updatedAt,
          }
        : null,
      lowBalanceThreshold,
      reconciliation,
      mutationsBlocked: mutationBlock(reconciliation) !== null,
      operations: this.access(userId),
      ledger: detail.ledger,
      holds: detail.holds,
      purchases: detail.purchases,
      events: detail.events,
      audit: detail.audit,
    };
  }
}

/**
 * Why staff may not change this account right now, or null. A drifted
 * projection is fixed by repair; contradictory source rows are escalated.
 */
export function mutationBlock(
  report: ReconciliationReport | null | undefined,
): StaffBillingErrorCode | null {
  if (!report) return STAFF_BILLING_ERROR_CODES.accountNotFound;
  if (report.contradictions.length)
    return STAFF_BILLING_ERROR_CODES.sourceContradictory;
  if (!report.consistent) return STAFF_BILLING_ERROR_CODES.projectionMismatch;
  return null;
}
