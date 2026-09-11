import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  paymobIntegrationIds,
  readStandaloneCreditBillingConfig,
} from '../../shared/config/standalone-credit-billing.config';
import type { StandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import { withSerializableRetry } from '../../shared/database/serializable-retry';
import {
  CreditAccountingRepository,
  CreditInvariantError,
} from '../../infrastructure/database/repositories/credit-accounting.repository';
import { PaymentPurchasesRepository } from '../../infrastructure/database/repositories/payment-purchases.repository';
import {
  DRIZZLE,
  type DrizzleDB,
} from '../../infrastructure/database/database.provider';
import type { CreditTransaction } from '../../infrastructure/database/credit-transaction';
import type { paymentPurchases } from '../../infrastructure/database/schema';
import type {
  DisputeStatus,
  NormalizedProviderEvent,
  PurchaseStatus,
} from '../../shared/ports/payments.port';
import {
  decidePurchaseTransition,
  type LedgerReversal,
  type PurchaseRejection,
} from './payment-purchase.policy';
import {
  STAFF_EVIDENCE_PROVIDER,
  type EventErrorCode,
  type EventResultCode,
  type ReconciliationCode,
} from './billing.types';

type Purchase = typeof paymentPurchases.$inferSelect;

function bindsTransaction(event: NormalizedProviderEvent): boolean {
  return event.signal === 'success';
}

export function paymentEventMismatch(
  event: NormalizedProviderEvent,
  purchase: Purchase,
  billing: StandaloneCreditBillingConfig,
): EventErrorCode | null {
  if (event.signal === 'expiry_confirmed' && event.source === 'inquiry') {
    if (
      event.provider !== 'akeed' ||
      event.reference !== purchase.reference ||
      event.payment.reference !== purchase.reference ||
      event.payment.providerIntentionId ||
      event.payment.providerOrderId ||
      event.payment.providerTransactionId
    )
      return 'ownership_mismatch';
    if (event.amountMinor !== 0) return 'amount_mismatch';
    if (event.currency !== purchase.currency) return 'currency_mismatch';
    if (event.integrationId !== 'akeed_inquiry') return 'integration_mismatch';
    if (event.mode !== purchase.mode) return 'mode_mismatch';
    return null;
  }
  const integrations = billing.enabled
    ? paymobIntegrationIds(billing.paymob)
    : [];
  if (event.amountMinor !== purchase.totalMinor) return 'amount_mismatch';
  if (event.currency !== purchase.currency) return 'currency_mismatch';
  if (!integrations.includes(event.integrationId))
    return 'integration_mismatch';
  if (
    event.mode !== purchase.mode ||
    (billing.enabled && event.mode !== billing.paymob.mode)
  )
    return 'mode_mismatch';
  if (event.provider !== purchase.provider) return 'ownership_mismatch';
  const bound: [string | null, string | undefined][] = [
    [purchase.providerIntentionId, event.payment.providerIntentionId],
    [purchase.providerOrderId, event.payment.providerOrderId],
  ];
  // The purchase is bound to the one transaction that paid for it. A declined
  // or pending attempt, a refund and a dispute each carry their own transaction
  // id, so only a second, different success is an ownership conflict.
  if (bindsTransaction(event))
    bound.push([
      purchase.providerTransactionId,
      event.payment.providerTransactionId,
    ]);
  for (const [stored, incoming] of bound)
    if (stored && incoming && stored !== incoming) return 'ownership_mismatch';
  return null;
}

export type StaffEvidenceAction =
  | 'refund'
  | 'chargeback_open'
  | 'chargeback_lost'
  | 'chargeback_won';

export interface StaffEvidenceInput {
  orgId: string;
  reference: string;
  action: StaffEvidenceAction;
  /** Provider refund or dispute identifier. */
  providerReference?: string;
  /**
   * For a refund, the cumulative amount the provider reports as refunded. For
   * a dispute, the disputed amount.
   */
  amountMinor: number;
  currency: string;
  actorId: string;
}

export interface StaffEvidenceResult {
  outcome:
    | 'not_found'
    | 'duplicate'
    | 'no_change'
    | 'transitioned'
    | 'reversed'
    | 'quarantined';
  resultCode: EventResultCode;
  errorCode?: EventErrorCode;
  reconciliationCode?: ReconciliationCode | null;
  rejected?: PurchaseRejection | null;
  reversal?: { type: LedgerReversal['type']; quantity: number } | null;
  purchase?: {
    status: PurchaseStatus;
    disputeStatus: DisputeStatus;
    refundedMinor: number;
  };
}

const QUARANTINE_ERROR_CODES: Partial<
  Record<ReconciliationCode, EventErrorCode>
> = {
  partial_refund_not_whole_credit: 'partial_refund_not_whole_credit',
  refund_without_success: 'refund_without_success',
  refund_reference_missing: 'refund_reference_missing',
  dispute_without_grant: 'dispute_without_grant',
};

function quarantineErrorCode(
  code: ReconciliationCode | null,
): EventErrorCode | undefined {
  return code ? QUARANTINE_ERROR_CODES[code] : undefined;
}

/**
 * What the HTTP layer should answer.
 *
 * `quarantined` is deliberately a success: the event is authentic, it changed
 * nothing, and asking the provider to redeliver it forever would not make it
 * matchable. `frozen` is the same reasoning applied to an account whose
 * projection no longer adds up.
 */
export type IngestOutcome =
  | 'granted'
  | 'transitioned'
  | 'no_change'
  | 'duplicate'
  | 'quarantined'
  | 'frozen';

export interface IngestResult {
  outcome: IngestOutcome;
  resultCode: EventResultCode;
  errorCode?: EventErrorCode;
}

/**
 * Turns a verified provider fact into credits, once.
 *
 * Callbacks and inquiry results both arrive here, and both carry a fingerprint
 * derived from provider data alone -- so whichever reaches the unique index
 * second is a proven replay, and a lost callback recovered by inquiry cannot
 * grant a second time.
 *
 * The event row, the purchase transition, the ledger entry and the account
 * projection commit together. That is what makes an injected failure safe: a
 * rollback takes the event row with it, so the retry is a first attempt rather
 * than a replay that skips the grant.
 */
@Injectable()
export class PaymentCallbackService {
  private readonly logger = new Logger(PaymentCallbackService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
    private readonly credits: CreditAccountingRepository,
    private readonly purchases: PaymentPurchasesRepository,
  ) {}

  async ingest(event: NormalizedProviderEvent): Promise<IngestResult> {
    try {
      const result = await withSerializableRetry(() =>
        this.db.transaction<IngestResult>((tx) => this.apply(tx, event)),
      );
      this.logger.log(
        buildBackendLog(PaymentCallbackService.name, {
          action: 'payment-callback-ingest',
          outcome: 'success',
          provider: event.provider,
          source: event.source,
          reference: event.reference,
          signal: event.signal,
          resultCode: result.resultCode,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        }),
      );
      if (result.resultCode === 'duplicate_event')
        this.alert('duplicate_grant_attempt', 'attention', event);
      // Raised only after commit, so a rolled-back quarantine does not page.
      if (result.outcome === 'quarantined')
        this.alert('trusted_data_mismatch', 'critical', event, {
          resultCode: result.resultCode,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        });
      return result;
    } catch (error) {
      if (error instanceof CreditInvariantError)
        return this.freeze(event, error);
      this.logger.error(
        buildBackendLog(PaymentCallbackService.name, {
          action: 'payment-callback-ingest',
          outcome: 'failure',
          provider: event.provider,
          reference: event.reference,
          ...normalizeError(error),
        }),
      );
      this.alert('callback_failure', 'critical', event, {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      // Deliberately rethrown: a transient database failure must answer non-2xx
      // so the provider retries and the grant still happens.
      throw error;
    }
  }

  private async apply(
    tx: CreditTransaction,
    event: NormalizedProviderEvent,
  ): Promise<IngestResult> {
    // The reference is the only identifier both sides agree on before any
    // provider id is bound, and this lock is what serializes two deliveries of
    // the same callback into one grant.
    const purchase = await this.purchases.lockByReference(tx, event.reference);
    if (!purchase)
      return this.quarantine(tx, event, null, 'unmatched_reference');

    const mismatch = this.mismatch(event, purchase);
    if (mismatch)
      return this.quarantine(
        tx,
        event,
        purchase,
        'trusted_data_mismatch',
        mismatch,
      );

    const reversals = await this.credits.readPurchaseReversals(
      tx,
      purchase.orgId,
      purchase.id,
    );
    const decision = decidePurchaseTransition({
      current: {
        status: purchase.status,
        disputeStatus: purchase.disputeStatus,
        quantity: purchase.quantity,
        unitPriceMinor: purchase.unitPriceMinor,
        totalMinor: purchase.totalMinor,
        refundedMinor: purchase.refundedMinor,
        ...reversals,
      },
      signal: event.signal,
      source: event.source,
      refundedMinorTotal: event.refundedMinorTotal,
      sourceReference: event.sourceReference,
    });

    // Recorded before anything is applied, and with the outcome it is about to
    // have. The unique `(provider, fingerprint)` index is what makes a second
    // delivery of the same provider fact a no-op: if the insert is absorbed,
    // this exact fact has already been applied and nothing more happens.
    const resultCode: EventResultCode = decision.grant
      ? 'granted'
      : decision.changed
        ? 'transitioned'
        : 'no_change';
    const recorded = await this.purchases.recordEvent(tx, {
      orgId: purchase.orgId,
      purchaseId: purchase.id,
      provider: event.provider,
      providerIntentionId: event.payment.providerIntentionId,
      providerOrderId: event.payment.providerOrderId,
      providerTransactionId: event.payment.providerTransactionId,
      fingerprint: event.fingerprint,
      payloadHash: event.payloadHash,
      verified: true,
      resultCode,
      errorCode: event.errorCode,
      processedAt: new Date().toISOString(),
    });
    if (!recorded)
      return { outcome: 'duplicate', resultCode: 'duplicate_event' };

    await this.bindProviderIds(tx, event, purchase);
    if (!decision.changed) return { outcome: 'no_change', resultCode };

    await this.purchases.updatePurchase(
      tx,
      purchase.orgId,
      purchase.id,
      purchase.status,
      {
        status: decision.status,
        disputeStatus: decision.disputeStatus,
        refundedMinor: decision.refundedMinor,
        ...(decision.reconciliationCode
          ? {
              reconciliationRequired: true,
              reconciliationCode: decision.reconciliationCode,
            }
          : { reconciliationRequired: false, reconciliationCode: null }),
      },
    );

    if (decision.grant) {
      await this.grant(tx, purchase, decision.grant.quantity, event.reference);
      return { outcome: 'granted', resultCode: 'granted' };
    }
    if (decision.reversal) await this.reverse(tx, purchase, decision.reversal);
    return { outcome: 'transitioned', resultCode };
  }

  /**
   * Every trusted field, checked against what was stored before the payment
   * existed. A mismatch grants nothing and is left for staff.
   */
  private mismatch(
    event: NormalizedProviderEvent,
    purchase: Purchase,
  ): EventErrorCode | null {
    const billing = readStandaloneCreditBillingConfig(this.config);
    return paymentEventMismatch(event, purchase, billing);
  }

  /**
   * Fills in identifiers the purchase does not have yet, and only those. The
   * transaction id comes only from a success: binding a declined attempt would
   * make the customer's successful retry look like someone else's payment.
   */
  private async bindProviderIds(
    tx: CreditTransaction,
    event: NormalizedProviderEvent,
    purchase: Purchase,
  ): Promise<void> {
    const changes = {
      ...(purchase.providerIntentionId || !event.payment.providerIntentionId
        ? {}
        : { providerIntentionId: event.payment.providerIntentionId }),
      ...(purchase.providerOrderId || !event.payment.providerOrderId
        ? {}
        : { providerOrderId: event.payment.providerOrderId }),
      ...(purchase.providerTransactionId ||
      !event.payment.providerTransactionId ||
      !bindsTransaction(event)
        ? {}
        : { providerTransactionId: event.payment.providerTransactionId }),
    };
    if (!Object.keys(changes).length) return;
    await this.purchases.updatePurchase(
      tx,
      purchase.orgId,
      purchase.id,
      purchase.status,
      changes,
    );
  }

  /**
   * Posts the purchased credits.
   *
   * Two independent database guarantees make a second grant impossible:
   * `credit_ledger_purchase_key` allows one `purchase` entry per purchase, and
   * `credit_ledger_idempotency_key` allows one entry per key per organization.
   * The invariant re-check afterwards refuses to leave a projection that no
   * longer matches the ledger.
   */
  private async grant(
    tx: CreditTransaction,
    purchase: Purchase,
    quantity: number,
    reference: string,
  ): Promise<void> {
    await this.credits.postLedgerEntry(tx, {
      orgId: purchase.orgId,
      type: 'purchase',
      quantity,
      idempotencyKey: `purchase:${reference}:v1`,
      purchaseId: purchase.id,
      reason: 'provider_payment_verified',
    });
  }

  /**
   * Takes credits back, or gives them back after a won dispute.
   *
   * The source entry is looked up rather than assumed: `guard_credit_ledger_source`
   * refuses a reversal whose source is the wrong type or belongs to another
   * purchase, and a reinstatement must be exactly opposite the chargeback
   * reversal carrying the same provider reference. The balance may go negative
   * -- debt is representable, and it blocks new holds through the existing
   * `creditDenial` path without any code here.
   */
  private async reverse(
    tx: CreditTransaction,
    purchase: Purchase,
    reversal: LedgerReversal,
    actorId?: string,
  ): Promise<number> {
    const sourceType =
      reversal.type === 'chargeback_reinstatement'
        ? 'chargeback_reversal'
        : 'purchase';
    const source = await this.credits.findPurchaseLedgerEntry(
      tx,
      purchase.orgId,
      purchase.id,
      sourceType,
      reversal.type === 'chargeback_reinstatement'
        ? reversal.sourceReference
        : undefined,
    );
    if (!source)
      throw new Error(
        `Cannot reverse purchase ${purchase.id}: no ${sourceType} entry to point at`,
      );
    const quantity =
      reversal.type === 'chargeback_reinstatement'
        ? -source.quantity
        : reversal.quantity;
    await this.credits.postLedgerEntry(tx, {
      orgId: purchase.orgId,
      type: reversal.type,
      quantity,
      idempotencyKey: `${reversal.type}:${purchase.reference}:${reversal.sourceReference}`,
      purchaseId: purchase.id,
      sourceLedgerEntryId: source.id,
      sourceReference: reversal.sourceReference,
      actorId,
      reason: reversal.type,
    });
    return quantity;
  }

  /**
   * Applies refund or dispute evidence a staff member recorded from the
   * provider's own records.
   *
   * It runs the same state machine and the same reversal as a callback, under
   * the same purchase-then-account lock order, with three differences that
   * keep it from ever being a way to assert a payment:
   *
   * - the purchase is locked by organization *and* reference, so one tenant's
   *   account cannot be paired with another tenant's payment;
   * - the policy refuses every signal except refund and dispute ones for this
   *   source, and a decision that would grant is treated as a defect;
   * - the event is stored under `akeed_staff`, `verified = false`, with a
   *   fingerprint over the recorded facts, so re-submitting the same evidence
   *   is a no-op.
   *
   * `audit` runs inside the transaction, so the staff audit row commits or
   * rolls back with the ledger entry and the projection it describes.
   */
  async recordStaffEvidence(
    input: StaffEvidenceInput,
    audit: (
      tx: CreditTransaction,
      result: StaffEvidenceResult,
    ) => Promise<void>,
  ): Promise<StaffEvidenceResult> {
    return withSerializableRetry(() =>
      this.db.transaction<StaffEvidenceResult>((tx) =>
        this.applyStaffEvidence(tx, input, audit),
      ),
    );
  }

  private async applyStaffEvidence(
    tx: CreditTransaction,
    input: StaffEvidenceInput,
    audit: (
      tx: CreditTransaction,
      result: StaffEvidenceResult,
    ) => Promise<void>,
  ): Promise<StaffEvidenceResult> {
    const purchase = await this.purchases.lockForOrganization(
      tx,
      input.orgId,
      input.reference,
    );
    if (!purchase)
      return { outcome: 'not_found', resultCode: 'unmatched_reference' };

    const providerReference = input.providerReference?.trim() || undefined;
    const facts = [
      STAFF_EVIDENCE_PROVIDER,
      purchase.id,
      input.action,
      providerReference ?? '',
      String(input.amountMinor),
      input.currency,
    ].join('|');
    const event = {
      orgId: purchase.orgId,
      purchaseId: purchase.id,
      provider: STAFF_EVIDENCE_PROVIDER,
      fingerprint: createHash('sha256').update(facts, 'utf8').digest('hex'),
      payloadHash: createHash('sha256')
        .update(`${facts}|${input.actorId}`, 'utf8')
        .digest('hex'),
      verified: false,
      processedAt: new Date().toISOString(),
    };

    const mismatch = this.evidenceMismatch(input, purchase);
    if (mismatch) {
      const recorded = await this.purchases.recordEvent(tx, {
        ...event,
        resultCode: 'trusted_data_mismatch',
        errorCode: mismatch,
      });
      const result: StaffEvidenceResult = recorded
        ? {
            outcome: 'quarantined',
            resultCode: 'trusted_data_mismatch',
            errorCode: mismatch,
            reconciliationCode: 'staff_evidence_mismatch',
          }
        : { outcome: 'duplicate', resultCode: 'duplicate_event' };
      if (recorded)
        await this.purchases.updatePurchase(
          tx,
          purchase.orgId,
          purchase.id,
          purchase.status,
          {
            reconciliationRequired: true,
            reconciliationCode: 'staff_evidence_mismatch',
          },
        );
      await audit(tx, result);
      return result;
    }

    const reversals = await this.credits.readPurchaseReversals(
      tx,
      purchase.orgId,
      purchase.id,
    );
    const decision = decidePurchaseTransition({
      current: {
        status: purchase.status,
        disputeStatus: purchase.disputeStatus,
        quantity: purchase.quantity,
        unitPriceMinor: purchase.unitPriceMinor,
        totalMinor: purchase.totalMinor,
        refundedMinor: purchase.refundedMinor,
        ...reversals,
      },
      signal: input.action,
      source: 'staff_evidence',
      refundedMinorTotal:
        input.action === 'refund' ? input.amountMinor : undefined,
      sourceReference: providerReference,
    });
    if (decision.grant)
      throw new Error('Staff evidence must never grant purchased credits');

    const outcome: StaffEvidenceResult['outcome'] = !decision.changed
      ? 'no_change'
      : decision.reversal
        ? 'reversed'
        : decision.reconciliationCode
          ? 'quarantined'
          : 'transitioned';
    const errorCode = quarantineErrorCode(decision.reconciliationCode);
    const resultCode: EventResultCode = decision.changed
      ? 'transitioned'
      : 'no_change';
    const recorded = await this.purchases.recordEvent(tx, {
      ...event,
      resultCode,
      errorCode: outcome === 'quarantined' ? errorCode : undefined,
    });
    if (!recorded) {
      const duplicate: StaffEvidenceResult = {
        outcome: 'duplicate',
        resultCode: 'duplicate_event',
      };
      await audit(tx, duplicate);
      return duplicate;
    }

    let reversedQuantity: number | undefined;
    if (decision.changed) {
      await this.purchases.updatePurchase(
        tx,
        purchase.orgId,
        purchase.id,
        purchase.status,
        {
          status: decision.status,
          disputeStatus: decision.disputeStatus,
          refundedMinor: decision.refundedMinor,
          // Evidence only ever raises a flag. An unrelated anomaly already on
          // the purchase stays for staff to clear.
          ...(decision.reconciliationCode
            ? {
                reconciliationRequired: true,
                reconciliationCode: decision.reconciliationCode,
              }
            : {}),
        },
      );
      if (decision.reversal)
        reversedQuantity = await this.reverse(
          tx,
          purchase,
          decision.reversal,
          input.actorId,
        );
    }
    const result: StaffEvidenceResult = {
      outcome,
      resultCode,
      ...(outcome === 'quarantined' && errorCode ? { errorCode } : {}),
      reconciliationCode: decision.reconciliationCode,
      rejected: decision.rejected,
      reversal:
        decision.reversal && reversedQuantity !== undefined
          ? { type: decision.reversal.type, quantity: reversedQuantity }
          : null,
      purchase: {
        status: decision.status,
        disputeStatus: decision.disputeStatus,
        refundedMinor: decision.refundedMinor,
      },
    };
    await audit(tx, result);
    return result;
  }

  /**
   * The recorded facts that cannot describe this purchase. A dispute is
   * all-or-nothing in the ledger, so a partial dispute is left for finance
   * rather than approximated.
   */
  private evidenceMismatch(
    input: StaffEvidenceInput,
    purchase: Purchase,
  ): EventErrorCode | null {
    if (input.currency !== purchase.currency) return 'currency_mismatch';
    if (input.amountMinor > purchase.totalMinor) return 'amount_mismatch';
    if (input.action !== 'refund' && input.amountMinor !== purchase.totalMinor)
      return 'dispute_amount_mismatch';
    return null;
  }

  /**
   * Records an authentic event that changed nothing and never will.
   *
   * It is stored in the same transaction that decided to quarantine it, so the
   * fingerprint is consumed and a redelivery is a cheap duplicate rather than
   * the same fruitless matching work.
   */
  private async quarantine(
    tx: CreditTransaction,
    event: NormalizedProviderEvent,
    purchase: Purchase | null,
    resultCode: EventResultCode,
    errorCode?: EventErrorCode,
  ): Promise<IngestResult> {
    await this.purchases.recordEvent(tx, {
      // Both null satisfies `payment_event_tenant_check`; an unmatched event
      // genuinely belongs to no tenant.
      orgId: purchase?.orgId ?? null,
      purchaseId: purchase?.id ?? null,
      provider: event.provider,
      providerIntentionId: event.payment.providerIntentionId,
      providerOrderId: event.payment.providerOrderId,
      providerTransactionId: event.payment.providerTransactionId,
      fingerprint: event.fingerprint,
      payloadHash: event.payloadHash,
      verified: true,
      resultCode,
      errorCode,
      processedAt: new Date().toISOString(),
    });
    if (purchase)
      await this.purchases.updatePurchase(
        tx,
        purchase.orgId,
        purchase.id,
        purchase.status,
        {
          reconciliationRequired: true,
          reconciliationCode: 'callback_mismatch',
        },
      );
    this.logger.warn(
      buildBackendLog(PaymentCallbackService.name, {
        action: 'payment-callback-quarantine',
        outcome: 'skipped',
        provider: event.provider,
        reference: event.reference,
        resultCode,
        ...(errorCode ? { errorCode } : {}),
      }),
    );
    return { outcome: 'quarantined', resultCode, errorCode };
  }

  /**
   * An account whose ledger and projection disagree stops accepting money.
   *
   * Answering 2xx here is a deliberate exception to "non-2xx on a database
   * failure": this one will not resolve by being retried, and a provider
   * hammering a frozen account only buries the alert.
   */
  private freeze(
    event: NormalizedProviderEvent,
    error: CreditInvariantError,
  ): IngestResult {
    this.logger.error(
      buildBackendLog(PaymentCallbackService.name, {
        action: 'payment-callback-ingest',
        outcome: 'failure',
        provider: event.provider,
        reference: event.reference,
        errorCode: 'credit_invariant_frozen',
        ...error.report,
      }),
    );
    this.alert('projection_mismatch', 'critical', event);
    return {
      outcome: 'frozen',
      resultCode: 'credit_invariant_frozen',
    };
  }

  /**
   * One structured event per incident for Railway log alerts. References are
   * searchable fields here, never metric dimensions.
   */
  private alert(
    alertCode: string,
    severity: 'attention' | 'critical',
    event: NormalizedProviderEvent,
    context: Record<string, unknown> = {},
  ): void {
    this.logger.warn(
      buildBackendLog(PaymentCallbackService.name, {
        action: 'standalone-billing-alert',
        outcome: 'failure',
        alertCode,
        severity,
        provider: event.provider,
        source: event.source,
        reference: event.reference,
        ...context,
      }),
    );
  }
}
