import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import {
  isStandaloneBillingOperator,
  readStandaloneBillingOperationsConfig,
} from '../../shared/config/standalone-billing-operations.config';
import {
  DRIZZLE,
  type DrizzleDB,
} from '../../infrastructure/database/database.provider';
import {
  CreditAccountingRepository,
  CreditInvariantError,
  CreditVersionConflictError,
} from '../../infrastructure/database/repositories/credit-accounting.repository';
import type { CreditTransaction } from '../../infrastructure/database/credit-transaction';
import type { creditAccounts } from '../../infrastructure/database/schema';
import {
  normalizeIdempotencyKey,
  PurchaseQuantityError,
} from '../billing/billing.policy';
import {
  balanceState,
  fingerprint,
} from './standalone-billing-operations.policy';
import { StandaloneBillingOperationsRepository } from './standalone-billing-operations.repository';
import {
  STAFF_BILLING_ACTIONS,
  STAFF_BILLING_ERROR_CODES,
  type BalanceProjection,
  type OperationsAccess,
  type ReconciliationReport,
  type StaffBillingErrorCode,
} from './standalone-billing-operations.types';

type Account = typeof creditAccounts.$inferSelect;

export function staffBillingError(
  Exception: new (response: object) => HttpException,
  code: StaffBillingErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new Exception({ message, code, ...details });
}

export function projection(account: {
  postedBalance: number;
  heldCredits: number;
}): BalanceProjection {
  return {
    postedBalance: account.postedBalance,
    heldCredits: account.heldCredits,
    availableCredits: Math.max(account.postedBalance - account.heldCredits, 0),
    debtCredits: Math.max(-account.postedBalance, 0),
  };
}

function adjustmentFingerprint(
  orgId: string,
  quantity: number,
  account: Account,
): string {
  return fingerprint({
    operation: 'staff_adjustment',
    orgId,
    quantity,
    status: account.status,
    postedBalance: account.postedBalance,
    heldCredits: account.heldCredits,
    version: account.version,
  });
}

export interface AdjustmentResult {
  outcome: 'applied' | 'duplicate';
  orgId: string;
  previewId: string;
  ledgerEntryId: string;
  quantity: number;
  before: BalanceProjection;
  after: BalanceProjection;
  appliedAt: string | null;
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
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly repository: StandaloneBillingOperationsRepository,
    private readonly credits: CreditAccountingRepository,
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
            ...projection(account),
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

  /**
   * Shows what a signed adjustment would do, and binds that answer to the
   * account state it was computed from.
   */
  async previewAdjustment(
    userId: string,
    orgId: string,
    quantity: number,
    requestId?: string,
  ) {
    const account = await this.mutableAccount(orgId);
    const bound = adjustmentFingerprint(orgId, quantity, account);
    const previewId = await this.repository.savePreview({
      userId,
      action: STAFF_BILLING_ACTIONS.adjustmentPreview,
      requestId,
      metadata: { orgId, quantity, fingerprint: bound },
    });
    return {
      previewId,
      fingerprint: bound,
      orgId,
      quantity,
      evaluatedAt: new Date().toISOString(),
      before: projection(account),
      after: projection({
        postedBalance: account.postedBalance + quantity,
        heldCredits: account.heldCredits,
      }),
    };
  }

  /**
   * Posts a reviewed adjustment exactly once.
   *
   * The account lock, the idempotency check, the staleness check, the ledger
   * entry, the projection and the audit row all happen in one transaction.
   * The quantity is the one the server stored with the preview; the request
   * contributes only which preview, a reason and an idempotency key.
   */
  async applyAdjustment(input: {
    userId: string;
    orgId: string;
    previewId: string;
    fingerprint: string;
    reason: string;
    idempotencyKey: string | undefined;
    requestId?: string;
  }): Promise<AdjustmentResult> {
    const key = this.idempotencyKey(input.idempotencyKey);
    const preview = await this.repository.readPreview(
      input.previewId,
      input.userId,
      STAFF_BILLING_ACTIONS.adjustmentPreview,
    );
    const quantity = preview?.quantity;
    if (
      !preview ||
      preview.version !== 1 ||
      preview.orgId !== input.orgId ||
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity === 0 ||
      typeof preview.fingerprint !== 'string'
    )
      staffBillingError(
        NotFoundException,
        STAFF_BILLING_ERROR_CODES.previewNotFound,
        'Adjustment preview not found.',
      );
    if (preview.fingerprint !== input.fingerprint)
      staffBillingError(
        ConflictException,
        STAFF_BILLING_ERROR_CODES.previewStale,
        'The adjustment does not match its preview.',
      );
    const ledgerKey = `staff_adjustment:${input.orgId}:${key}`;

    return this.locked(() =>
      this.db.transaction(async (tx) => {
        const account = await this.credits.lockAccount(tx, input.orgId);
        const existing = await this.credits.findLedgerEntry(
          tx,
          input.orgId,
          ledgerKey,
        );
        if (existing) {
          const prior = await this.repository.findApplied(
            tx,
            STAFF_BILLING_ACTIONS.adjustmentApply,
            'ledgerEntryId',
            existing.id,
          );
          if (prior?.metadata.previewId !== input.previewId)
            staffBillingError(
              ConflictException,
              STAFF_BILLING_ERROR_CODES.idempotencyConflict,
              'Idempotency-Key was already used for another adjustment.',
            );
          return {
            outcome: 'duplicate' as const,
            orgId: input.orgId,
            previewId: input.previewId,
            ledgerEntryId: existing.id,
            quantity: existing.quantity,
            before: projection({
              postedBalance: existing.postedBalanceBefore,
              heldCredits: Number(prior.metadata.heldCreditsBefore ?? 0),
            }),
            after: projection({
              postedBalance: existing.postedBalanceAfter,
              heldCredits: Number(prior.metadata.heldCreditsAfter ?? 0),
            }),
            appliedAt: existing.createdAt,
          };
        }
        const applied = await this.repository.findApplied(
          tx,
          STAFF_BILLING_ACTIONS.adjustmentApply,
          'previewId',
          input.previewId,
        );
        if (applied)
          staffBillingError(
            ConflictException,
            STAFF_BILLING_ERROR_CODES.previewAlreadyApplied,
            'This preview was already applied.',
          );
        await this.assertNoContradictions(input.orgId, tx);
        if (account.status === 'pending_approval')
          staffBillingError(
            ConflictException,
            STAFF_BILLING_ERROR_CODES.accountNotApproved,
            'Approve the organization before adjusting its credits.',
          );
        if (
          adjustmentFingerprint(input.orgId, quantity, account) !==
          preview.fingerprint
        )
          staffBillingError(
            ConflictException,
            STAFF_BILLING_ERROR_CODES.previewStale,
            'The account changed after the preview; preview again.',
          );
        const posted = await this.credits.postLedgerEntry(
          tx,
          {
            orgId: input.orgId,
            type: 'staff_adjustment',
            quantity,
            idempotencyKey: ledgerKey,
            actorId: input.userId,
            reason: input.reason,
          },
          account,
        );
        await this.repository.insertAudit(tx, {
          userId: input.userId,
          action: STAFF_BILLING_ACTIONS.adjustmentApply,
          requestId: input.requestId,
          metadata: {
            orgId: input.orgId,
            previewId: input.previewId,
            idempotencyKey: key,
            ledgerEntryId: posted.entry.id,
            quantity,
            reason: input.reason,
            postedBalanceBefore: posted.before.postedBalance,
            postedBalanceAfter: posted.after.postedBalance,
            heldCreditsBefore: posted.before.heldCredits,
            heldCreditsAfter: posted.after.heldCredits,
          },
        });
        return {
          outcome: 'applied' as const,
          orgId: input.orgId,
          previewId: input.previewId,
          ledgerEntryId: posted.entry.id,
          quantity,
          before: projection(posted.before),
          after: projection(posted.after),
          appliedAt: posted.entry.createdAt,
        };
      }),
    );
  }

  /**
   * The account staff may change right now: it exists, it was approved, and
   * its projection and source rows agree.
   */
  private async mutableAccount(orgId: string): Promise<Account> {
    const account = await this.repository.readAccount(orgId);
    if (!account)
      staffBillingError(
        NotFoundException,
        STAFF_BILLING_ERROR_CODES.accountNotFound,
        'Credit account not found.',
      );
    if (account.status === 'pending_approval')
      staffBillingError(
        ConflictException,
        STAFF_BILLING_ERROR_CODES.accountNotApproved,
        'Approve the organization before adjusting its credits.',
      );
    const block = mutationBlock(
      await this.repository.readReconciliation(orgId),
    );
    if (block) this.refuse(block);
    return account;
  }

  private async assertNoContradictions(orgId: string, tx: CreditTransaction) {
    const report = await this.repository.readReconciliation(orgId, tx);
    const block = mutationBlock(report);
    if (block) this.refuse(block);
  }

  private refuse(code: StaffBillingErrorCode): never {
    if (code === STAFF_BILLING_ERROR_CODES.accountNotFound)
      staffBillingError(NotFoundException, code, 'Credit account not found.');
    staffBillingError(
      ConflictException,
      code,
      code === STAFF_BILLING_ERROR_CODES.sourceContradictory
        ? 'Credit source rows contradict each other; escalate before changing this account.'
        : 'The credit projection does not match its ledger; repair it first.',
    );
  }

  private idempotencyKey(value: string | undefined): string {
    try {
      return normalizeIdempotencyKey(value);
    } catch (error) {
      if (!(error instanceof PurchaseQuantityError)) throw error;
      staffBillingError(
        BadRequestException,
        STAFF_BILLING_ERROR_CODES.idempotencyKeyRequired,
        error.detail,
      );
    }
  }

  /** Converts the accounting layer's refusals into staff-facing answers. */
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CreditInvariantError)
        this.refuse(STAFF_BILLING_ERROR_CODES.projectionMismatch);
      if (error instanceof CreditVersionConflictError)
        staffBillingError(
          ConflictException,
          STAFF_BILLING_ERROR_CODES.previewStale,
          'The account changed during the operation; preview again.',
        );
      if (
        error instanceof Error &&
        error.message === 'Credit account not found'
      )
        this.refuse(STAFF_BILLING_ERROR_CODES.accountNotFound);
      throw error;
    }
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
