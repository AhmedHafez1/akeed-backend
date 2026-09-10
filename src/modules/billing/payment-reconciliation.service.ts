import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  DRIZZLE,
  type DrizzleDB,
} from '../../infrastructure/database/database.provider';
import type { CreditTransaction } from '../../infrastructure/database/credit-transaction';
import { PaymentPurchasesRepository } from '../../infrastructure/database/repositories/payment-purchases.repository';
import {
  PAYMENTS_PORT,
  type NormalizedProviderEvent,
  type PaymentInquiryResult,
  type PaymentsPort,
  type PurchaseStatus,
} from '../../shared/ports/payments.port';
import {
  PaymentCallbackService,
  type IngestResult,
} from './payment-callback.service';

/**
 * First retry is soon, because most stale purchases resolve on the first ask.
 * The ceiling stops a permanently unanswerable reference from being asked about
 * forever.
 */
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Non-final states a verified success reported by inquiry may still promote. */
const PROMOTABLE_BY_INQUIRY = new Set<PurchaseStatus>([
  'failed',
  'canceled',
  'expired',
]);

export type ReconcileOutcome =
  | 'not_eligible'
  | 'not_due'
  | 'resolved'
  | 'expired'
  | 'deferred';

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  ingest?: IngestResult;
}

/**
 * Asks the provider what happened to a purchase nothing has told us about.
 *
 * The answer is fed through the same ingestion path a callback takes, with a
 * fingerprint the provider adapter derives identically for both. That is the
 * whole safety argument: recovering a lost callback and then receiving the real
 * one cannot grant twice.
 *
 * Nothing here decides an outcome on its own. In particular a purchase is only
 * ever marked expired when the provider confirms it never succeeded -- silence
 * is not confirmation.
 */
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly purchases: PaymentPurchasesRepository,
    private readonly callbacks: PaymentCallbackService,
    @Inject(PAYMENTS_PORT) private readonly payments: PaymentsPort,
  ) {}

  /**
   * `force` is the staff path. It may ask about a pending purchase still inside
   * its checkout window, or about a flagged failed/canceled/expired one that a
   * delayed success could still promote, and it ignores the backoff. It changes
   * nothing else: the answer still goes through ingestion, and expiry still
   * needs both an elapsed window and a provider that reports nothing.
   */
  async reconcile(
    orgId: string,
    reference: string,
    options: { force?: boolean } = {},
  ): Promise<ReconcileResult> {
    const purchase = await this.purchases.findReconciliationTarget(
      orgId,
      reference,
    );
    if (!purchase) return { outcome: 'not_eligible' };

    const now = Date.now();
    const expired = purchase.checkoutExpiresAt
      ? Date.parse(purchase.checkoutExpiresAt) <= now
      : false;
    if (options.force) {
      if (
        purchase.status !== 'pending' &&
        !(
          purchase.reconciliationRequired &&
          PROMOTABLE_BY_INQUIRY.has(purchase.status)
        )
      )
        return { outcome: 'not_eligible' };
    } else {
      // Only a purchase that is still pending has anything to learn, and only
      // one that is past its checkout window or already flagged is worth
      // asking about.
      if (purchase.status !== 'pending') return { outcome: 'not_eligible' };
      if (!expired && !purchase.reconciliationRequired)
        return { outcome: 'not_eligible' };
      if (
        purchase.nextReconciliationAt &&
        Date.parse(purchase.nextReconciliationAt) > now
      )
        return { outcome: 'not_due' };
    }

    let result: PaymentInquiryResult;
    try {
      result = await this.payments.inquire({
        reference: purchase.reference,
        providerIntentionId: purchase.providerIntentionId ?? undefined,
        providerOrderId: purchase.providerOrderId ?? undefined,
        providerTransactionId: purchase.providerTransactionId ?? undefined,
      });
    } catch (error) {
      this.logger.error(
        buildBackendLog(PaymentReconciliationService.name, {
          action: 'payment-inquiry',
          outcome: 'failure',
          orgId,
          reference,
          ...normalizeError(error),
        }),
      );
      return this.defer(purchase, 'inquiry_failed');
    }

    if (result.outcome === 'found') {
      const ingest = await this.callbacks.ingest(result.event);
      return { outcome: 'resolved', ingest };
    }
    if (
      result.outcome === 'not_found' &&
      expired &&
      purchase.status === 'pending'
    ) {
      // The one path that may expire a purchase, and only because the provider
      // was asked and reported nothing.
      const ingest = await this.callbacks.ingest(
        this.expiryEvent(purchase.reference),
      );
      return { outcome: 'expired', ingest };
    }
    return this.defer(purchase, result.code);
  }

  /**
   * A synthetic fact: the provider has no record of this reference.
   *
   * Its fingerprint is derived from the reference alone, so repeated
   * confirmations of the same non-existent payment collapse into one event
   * rather than accumulating.
   */
  private expiryEvent(reference: string): NormalizedProviderEvent {
    const fingerprint = createHash('sha256')
      .update(`inquiry|expiry_confirmed|${reference}`, 'utf8')
      .digest('hex');
    return {
      provider: 'akeed',
      source: 'inquiry',
      reference,
      signal: 'expiry_confirmed',
      payment: { reference },
      amountMinor: 0,
      currency: 'EGP',
      integrationId: 'akeed_inquiry',
      mode: 'test',
      fingerprint,
      payloadHash: fingerprint,
    };
  }

  /**
   * Backs off without ever concluding anything.
   *
   * Exponential with a ceiling, and jittered so a batch of purchases that went
   * stale together does not come back as a synchronized wave.
   */
  private async defer(
    purchase: {
      orgId: string;
      id: string;
      status: PurchaseStatus;
      reconciliationCode: string | null;
      reconciliationAttempts: number;
    },
    code: string,
  ): Promise<ReconcileResult> {
    const attempts = purchase.reconciliationAttempts + 1;
    const window = Math.min(
      BASE_BACKOFF_MS * 2 ** (attempts - 1),
      MAX_BACKOFF_MS,
    );
    const delay = Math.floor(window / 2 + Math.random() * (window / 2));
    await this.db.transaction((tx: CreditTransaction) =>
      this.purchases.updatePurchase(
        tx,
        purchase.orgId,
        purchase.id,
        purchase.status,
        {
          reconciliationRequired: true,
          // A flagged non-pending purchase keeps the anomaly it was flagged
          // for; an unanswered inquiry does not explain it away.
          reconciliationCode:
            purchase.status === 'pending'
              ? 'inquiry_unresolved'
              : (purchase.reconciliationCode ?? 'inquiry_unresolved'),
          reconciliationAttempts: attempts,
          nextReconciliationAt: new Date(Date.now() + delay).toISOString(),
        },
      ),
    );
    this.logger.warn(
      buildBackendLog(PaymentReconciliationService.name, {
        action: 'payment-inquiry-deferred',
        outcome: 'retry',
        orgId: purchase.orgId,
        attempts,
        delayMs: delay,
        errorCode: code,
      }),
    );
    return { outcome: 'deferred' };
  }
}
