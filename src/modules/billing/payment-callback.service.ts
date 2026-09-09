import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
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
import type { NormalizedProviderEvent } from '../../shared/ports/payments.port';
import {
  decidePurchaseTransition,
  type LedgerReversal,
} from './payment-purchase.policy';
import type { EventErrorCode, EventResultCode } from './billing.types';

type Purchase = typeof paymentPurchases.$inferSelect;

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
    const integrations = billing.enabled
      ? [billing.paymob.cardIntegrationId, billing.paymob.walletIntegrationId]
      : [];
    if (event.amountMinor !== purchase.totalMinor) return 'amount_mismatch';
    if (event.currency !== purchase.currency) return 'currency_mismatch';
    if (!integrations.includes(event.integrationId))
      return 'integration_mismatch';
    // Both directions: a live payment must not settle a test purchase, and a
    // test payment must not settle a live one.
    if (
      event.mode !== purchase.mode ||
      (billing.enabled && event.mode !== billing.paymob.mode)
    )
      return 'mode_mismatch';
    if (event.provider !== purchase.provider) return 'ownership_mismatch';
    const bound: [string | null, string | undefined][] = [
      [purchase.providerIntentionId, event.payment.providerIntentionId],
      [purchase.providerOrderId, event.payment.providerOrderId],
      [purchase.providerTransactionId, event.payment.providerTransactionId],
    ];
    // A bound identifier is immutable; an event naming a different one is
    // about somebody else's payment.
    for (const [stored, incoming] of bound)
      if (stored && incoming && stored !== incoming)
        return 'ownership_mismatch';
    return null;
  }

  /** Fills in identifiers the purchase does not have yet, and only those. */
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
      ...(purchase.providerTransactionId || !event.payment.providerTransactionId
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
    const account = await this.credits.lockAccount(tx, purchase.orgId);
    await this.credits.insertLedgerEntry(tx, {
      orgId: purchase.orgId,
      type: 'purchase',
      quantity,
      idempotencyKey: `purchase:${reference}:v1`,
      purchaseId: purchase.id,
      reason: 'provider_payment_verified',
      postedBalanceBefore: account.postedBalance,
      postedBalanceAfter: account.postedBalance + quantity,
    });
    await this.credits.updateProjection(tx, {
      orgId: purchase.orgId,
      expectedVersion: account.version,
      postedBalance: account.postedBalance + quantity,
      heldCredits: account.heldCredits,
    });
    await this.assertConsistent(tx, purchase.orgId);
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
  ): Promise<void> {
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
    const account = await this.credits.lockAccount(tx, purchase.orgId);
    await this.credits.insertLedgerEntry(tx, {
      orgId: purchase.orgId,
      type: reversal.type,
      quantity,
      idempotencyKey: `${reversal.type}:${purchase.reference}:${reversal.sourceReference}`,
      purchaseId: purchase.id,
      sourceLedgerEntryId: source.id,
      sourceReference: reversal.sourceReference,
      reason: reversal.type,
      postedBalanceBefore: account.postedBalance,
      postedBalanceAfter: account.postedBalance + quantity,
    });
    await this.credits.updateProjection(tx, {
      orgId: purchase.orgId,
      expectedVersion: account.version,
      postedBalance: account.postedBalance + quantity,
      heldCredits: account.heldCredits,
    });
    await this.assertConsistent(tx, purchase.orgId);
  }

  private async assertConsistent(
    tx: CreditTransaction,
    orgId: string,
  ): Promise<void> {
    const report = await this.credits.checkInvariant(orgId, tx);
    if (!report?.consistent)
      throw new CreditInvariantError(
        report ?? {
          orgId,
          postedBalance: 0,
          heldCredits: 0,
          ledgerBalance: '0',
          reservationHolds: '0',
          consistent: false,
        },
      );
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
    return {
      outcome: 'frozen',
      resultCode: 'credit_invariant_frozen',
    };
  }
}
