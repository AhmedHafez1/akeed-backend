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
import { PaymentPurchasesRepository } from '../../infrastructure/database/repositories/payment-purchases.repository';
import { VerificationMessageDispatchesRepository } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import {
  PaymentCallbackService,
  type StaffEvidenceAction,
  type StaffEvidenceResult,
} from '../billing/payment-callback.service';
import { PaymentReconciliationService } from '../billing/payment-reconciliation.service';
import { MessageDispatchResolutionService } from './message-dispatch-resolution.service';
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

function repairFingerprint(
  orgId: string,
  account: Account,
  report: ReconciliationReport,
  ledgerEntries: number,
): string {
  return fingerprint({
    operation: 'projection_repair',
    orgId,
    version: account.version,
    postedBalance: account.postedBalance,
    heldCredits: account.heldCredits,
    ledgerBalance: report.ledgerBalance,
    reservationHolds: report.reservationHolds,
    ledgerEntries,
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
    private readonly dispatches: VerificationMessageDispatchesRepository,
    private readonly dispatchResolution: MessageDispatchResolutionService,
    private readonly purchases: PaymentPurchasesRepository,
    private readonly callbacks: PaymentCallbackService,
    private readonly reconciliation: PaymentReconciliationService,
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
            activatedAt: detail.activatedAt,
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
   * Settles an ambiguous send for one tenant.
   *
   * The dispatch must belong to the organization the staff member is working
   * on -- a dispatch id from any other tenant answers exactly like one that
   * does not exist -- and must be credit billed. The existing resolver then
   * consumes or releases the held credit exactly once, under the dispatch
   * path's own integration-then-account lock order, and schedules the next
   * attempt only where the retry-generation rules allow one.
   */
  async resolveDispatch(input: {
    userId: string;
    orgId: string;
    dispatchId: string;
    resolution: 'accepted' | 'not_accepted';
    providerMessageId?: string;
    evidence?: string;
    reason: string;
    requestId?: string;
  }) {
    const dispatch = await this.dispatches.findById(input.dispatchId);
    if (!dispatch || dispatch.orgId !== input.orgId)
      staffBillingError(
        NotFoundException,
        STAFF_BILLING_ERROR_CODES.dispatchNotFound,
        'Message dispatch not found.',
      );
    if (dispatch.accountingMode !== 'prepaid_credit')
      staffBillingError(
        ConflictException,
        STAFF_BILLING_ERROR_CODES.dispatchNotCreditBilled,
        'This send is not billed through credits.',
      );
    await this.assertMutable(input.orgId);
    const result = await this.locked(() =>
      this.dispatchResolution.resolve(
        input.userId,
        input.dispatchId,
        {
          resolution: input.resolution,
          providerMessageId: input.providerMessageId,
          reason: input.reason,
        },
        { evidence: input.evidence, requestId: input.requestId },
      ),
    );
    return {
      outcome: result.state,
      dispatchId: result.dispatchId,
      duplicate: result.duplicate,
    };
  }

  /**
   * Asks the provider about one purchase, now.
   *
   * The inquiry is keyed only by identifiers already stored on the purchase,
   * and its answer runs through the same verified ingestion a callback does.
   * There is no input by which staff could name an outcome.
   */
  async reconcilePurchase(input: {
    userId: string;
    orgId: string;
    reference: string;
    reason: string;
    requestId?: string;
  }) {
    const target = await this.purchases.findReconciliationTarget(
      input.orgId,
      input.reference,
    );
    if (!target)
      staffBillingError(
        NotFoundException,
        STAFF_BILLING_ERROR_CODES.purchaseNotFound,
        'Purchase not found.',
      );
    await this.assertMutable(input.orgId);
    const result = await this.reconciliation.reconcile(
      input.orgId,
      input.reference,
      { force: true },
    );
    if (result.outcome === 'not_eligible')
      staffBillingError(
        ConflictException,
        STAFF_BILLING_ERROR_CODES.purchaseNotEligible,
        'Only a pending purchase, or a flagged one a delayed success could still settle, can be inquired.',
        { status: target.status },
      );
    const after = await this.purchases.findReconciliationTarget(
      input.orgId,
      input.reference,
    );
    await this.repository.insertAudit(this.db, {
      userId: input.userId,
      action: STAFF_BILLING_ACTIONS.purchaseReconcile,
      requestId: input.requestId,
      metadata: {
        orgId: input.orgId,
        reference: input.reference,
        reason: input.reason,
        outcome: result.outcome,
        resultCode: result.ingest?.resultCode ?? null,
        errorCode: result.ingest?.errorCode ?? null,
        reconciliationCode: after?.reconciliationCode ?? null,
      },
    });
    return {
      outcome: result.outcome,
      reference: input.reference,
      ingest: result.ingest ?? null,
      purchase: after
        ? {
            status: after.status,
            reconciliationRequired: after.reconciliationRequired,
            reconciliationCode: after.reconciliationCode,
            reconciliationAttempts: after.reconciliationAttempts,
            nextReconciliationAt: after.nextReconciliationAt,
          }
        : null,
    };
  }

  /**
   * Records refund or dispute evidence staff copied from the provider.
   *
   * It can reverse or reinstate purchased credits through the same state
   * machine a callback uses, and it can quarantine a purchase; it can never
   * grant, and it never trusts an amount that does not match the purchase.
   */
  async recordProviderAction(input: {
    userId: string;
    orgId: string;
    reference: string;
    action: StaffEvidenceAction;
    providerReference?: string;
    amountMinor: number;
    currency: string;
    evidence: string;
    reason: string;
    requestId?: string;
  }) {
    await this.assertMutable(input.orgId);
    const result = await this.locked(() =>
      this.callbacks.recordStaffEvidence(
        {
          orgId: input.orgId,
          reference: input.reference,
          action: input.action,
          providerReference: input.providerReference,
          amountMinor: input.amountMinor,
          currency: input.currency,
          actorId: input.userId,
        },
        async (tx: CreditTransaction, recorded: StaffEvidenceResult) => {
          await this.repository.insertAudit(tx, {
            userId: input.userId,
            action: STAFF_BILLING_ACTIONS.providerAction,
            requestId: input.requestId,
            metadata: {
              orgId: input.orgId,
              reference: input.reference,
              providerAction: input.action,
              providerReference: input.providerReference ?? null,
              amountMinor: input.amountMinor,
              currency: input.currency,
              evidence: input.evidence,
              reason: input.reason,
              outcome: recorded.outcome,
              resultCode: recorded.resultCode,
              errorCode: recorded.errorCode ?? null,
              reconciliationCode: recorded.reconciliationCode ?? null,
              reversalType: recorded.reversal?.type ?? null,
              reversalQuantity: recorded.reversal?.quantity ?? null,
            },
          });
        },
      ),
    );
    if (result.outcome === 'not_found')
      staffBillingError(
        NotFoundException,
        STAFF_BILLING_ERROR_CODES.purchaseNotFound,
        'Purchase not found.',
      );
    return { ...result, reference: input.reference };
  }

  /**
   * Shows what rebuilding the projection from its sources would change.
   *
   * A repair is only offered when there is drift to fix and the ledger and
   * reservations agree with each other; contradictory source rows are named
   * and left for escalation, because rebuilding from them would pick a side.
   */
  async previewRepair(userId: string, orgId: string, requestId?: string) {
    const account = await this.repository.readAccount(orgId);
    const report = account
      ? await this.repository.readReconciliation(orgId)
      : undefined;
    if (!account || !report)
      staffBillingError(
        NotFoundException,
        STAFF_BILLING_ERROR_CODES.accountNotFound,
        'Credit account not found.',
      );
    const ledgerEntries = await this.repository.ledgerCount(orgId);
    const bound = repairFingerprint(orgId, account, report, ledgerEntries);
    const outcome = report.contradictions.length
      ? ('contradictory' as const)
      : report.consistent
        ? ('already_consistent' as const)
        : ('repairable' as const);
    const previewId =
      outcome === 'repairable'
        ? await this.repository.savePreview({
            userId,
            action: STAFF_BILLING_ACTIONS.repairPreview,
            requestId,
            metadata: { orgId, fingerprint: bound },
          })
        : null;
    return {
      outcome,
      previewId,
      fingerprint: previewId ? bound : null,
      orgId,
      evaluatedAt: new Date().toISOString(),
      reconciliation: report,
      ledgerEntries,
      before: projection(account),
      after: projection({
        postedBalance: report.ledgerBalance,
        heldCredits: report.reservationHolds,
      }),
    };
  }

  /**
   * Rebuilds the projection from the immutable ledger and the held
   * reservations, under the account lock and a lock on every held
   * reservation, and records exactly what changed.
   *
   * Nothing is posted: the ledger is the authority and stays untouched. Every
   * other writer takes the account lock first and refuses a drifted account,
   * so nothing can move the sources between the recount and the write.
   */
  async applyRepair(input: {
    userId: string;
    orgId: string;
    previewId: string;
    fingerprint: string;
    reason: string;
    requestId?: string;
  }) {
    const preview = await this.repository.readPreview(
      input.previewId,
      input.userId,
      STAFF_BILLING_ACTIONS.repairPreview,
    );
    if (
      !preview ||
      preview.version !== 1 ||
      preview.orgId !== input.orgId ||
      typeof preview.fingerprint !== 'string'
    )
      staffBillingError(
        NotFoundException,
        STAFF_BILLING_ERROR_CODES.previewNotFound,
        'Repair preview not found.',
      );
    if (preview.fingerprint !== input.fingerprint)
      staffBillingError(
        ConflictException,
        STAFF_BILLING_ERROR_CODES.previewStale,
        'The repair does not match its preview.',
      );

    return this.locked(() =>
      this.db.transaction(async (tx) => {
        const account = await this.credits.lockAccountForRepair(
          tx,
          input.orgId,
        );
        if (!account) this.refuse(STAFF_BILLING_ERROR_CODES.accountNotFound);
        const held = await this.repository.lockHeldReservations(
          tx,
          input.orgId,
        );
        const prior = await this.repository.findApplied(
          tx,
          STAFF_BILLING_ACTIONS.repairApply,
          'previewId',
          input.previewId,
        );
        if (prior)
          return {
            outcome: 'already_applied' as const,
            orgId: input.orgId,
            previewId: input.previewId,
            before: projection({
              postedBalance: Number(prior.metadata.postedBalanceBefore),
              heldCredits: Number(prior.metadata.heldCreditsBefore),
            }),
            after: projection({
              postedBalance: Number(prior.metadata.postedBalanceAfter),
              heldCredits: Number(prior.metadata.heldCreditsAfter),
            }),
            appliedAt: prior.createdAt,
          };
        const report = await this.repository.readReconciliation(
          input.orgId,
          tx,
        );
        if (!report) this.refuse(STAFF_BILLING_ERROR_CODES.accountNotFound);
        if (report.contradictions.length)
          staffBillingError(
            ConflictException,
            STAFF_BILLING_ERROR_CODES.repairContradictory,
            'Credit source rows contradict each other; the projection cannot be rebuilt from them.',
            { contradictions: report.contradictions },
          );
        const ledgerEntries = await this.repository.ledgerCount(
          input.orgId,
          tx,
        );
        if (
          repairFingerprint(input.orgId, account, report, ledgerEntries) !==
          preview.fingerprint
        )
          staffBillingError(
            ConflictException,
            STAFF_BILLING_ERROR_CODES.previewStale,
            'The account changed after the preview; preview again.',
          );
        const heldCredits = held.reduce(
          (total, reservation) => total + reservation.quantity,
          0,
        );
        const repaired = await this.credits.updateProjection(tx, {
          orgId: input.orgId,
          expectedVersion: account.version,
          postedBalance: report.ledgerBalance,
          heldCredits,
        });
        await this.credits.assertConsistent(tx, input.orgId);
        await this.repository.insertAudit(tx, {
          userId: input.userId,
          action: STAFF_BILLING_ACTIONS.repairApply,
          requestId: input.requestId,
          metadata: {
            orgId: input.orgId,
            previewId: input.previewId,
            reason: input.reason,
            ledgerEntries,
            postedBalanceBefore: account.postedBalance,
            postedBalanceAfter: repaired.postedBalance,
            heldCreditsBefore: account.heldCredits,
            heldCreditsAfter: repaired.heldCredits,
            postedDifference: repaired.postedBalance - account.postedBalance,
            heldDifference: repaired.heldCredits - account.heldCredits,
          },
        });
        return {
          outcome: 'repaired' as const,
          orgId: input.orgId,
          previewId: input.previewId,
          before: projection(account),
          after: projection(repaired),
          appliedAt: repaired.updatedAt,
        };
      }),
    );
  }

  private async assertMutable(orgId: string) {
    const block = mutationBlock(
      await this.repository.readReconciliation(orgId),
    );
    if (block) this.refuse(block);
  }

  /**
   * The account staff may change right now: it exists and its projection and
   * source rows agree.
   */
  private async mutableAccount(orgId: string): Promise<Account> {
    const account = await this.repository.readAccount(orgId);
    if (!account)
      staffBillingError(
        NotFoundException,
        STAFF_BILLING_ERROR_CODES.accountNotFound,
        'Credit account not found.',
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
