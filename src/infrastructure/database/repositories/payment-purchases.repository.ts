import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { CreditTransaction } from '../credit-transaction';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { paymentProviderEvents, paymentPurchases } from '../schema';

type PurchaseInsert = typeof paymentPurchases.$inferInsert;
type EventInsert = typeof paymentProviderEvents.$inferInsert;

export class PaymentRequestConflictError extends Error {
  constructor() {
    super('The purchase idempotency key was used with different payment terms');
  }
}

export type NewPaymentPurchase = Pick<
  PurchaseInsert,
  | 'orgId'
  | 'reference'
  | 'provider'
  | 'mode'
  | 'requestKey'
  | 'requestHash'
  | 'quantity'
  | 'unitPriceMinor'
  | 'totalMinor'
  | 'currency'
  | 'checkoutExpiresAt'
>;

export type PaymentPurchaseUpdate = Partial<
  Pick<
    PurchaseInsert,
    | 'status'
    | 'disputeStatus'
    | 'providerIntentionId'
    | 'providerOrderId'
    | 'providerTransactionId'
    | 'checkoutExpiresAt'
    | 'refundedMinor'
    | 'reconciliationRequired'
    | 'reconciliationCode'
    | 'reconciliationAttempts'
    | 'nextReconciliationAt'
  >
>;

@Injectable()
export class PaymentPurchasesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findForOrganization(orgId: string, reference: string) {
    const [purchase] = await this.db
      .select({
        reference: paymentPurchases.reference,
        quantity: paymentPurchases.quantity,
        unitPriceMinor: paymentPurchases.unitPriceMinor,
        totalMinor: paymentPurchases.totalMinor,
        currency: paymentPurchases.currency,
        status: paymentPurchases.status,
        disputeStatus: paymentPurchases.disputeStatus,
        refundedMinor: paymentPurchases.refundedMinor,
        checkoutExpiresAt: paymentPurchases.checkoutExpiresAt,
        createdAt: paymentPurchases.createdAt,
      })
      .from(paymentPurchases)
      .where(
        and(
          eq(paymentPurchases.orgId, orgId),
          eq(paymentPurchases.reference, reference),
        ),
      );
    return purchase;
  }

  /** Adds the reconciliation flag a merchant's polling page needs to see. */
  async findDetailForOrganization(orgId: string, reference: string) {
    const [purchase] = await this.db
      .select({
        reference: paymentPurchases.reference,
        quantity: paymentPurchases.quantity,
        unitPriceMinor: paymentPurchases.unitPriceMinor,
        totalMinor: paymentPurchases.totalMinor,
        currency: paymentPurchases.currency,
        status: paymentPurchases.status,
        disputeStatus: paymentPurchases.disputeStatus,
        refundedMinor: paymentPurchases.refundedMinor,
        checkoutExpiresAt: paymentPurchases.checkoutExpiresAt,
        createdAt: paymentPurchases.createdAt,
        updatedAt: paymentPurchases.updatedAt,
        // The boolean, never the code: a reconciliation code names an internal
        // anomaly and is for staff tooling.
        reconciliationRequired: paymentPurchases.reconciliationRequired,
        nextReconciliationAt: paymentPurchases.nextReconciliationAt,
        providerOrderId: paymentPurchases.providerOrderId,
        providerTransactionId: paymentPurchases.providerTransactionId,
      })
      .from(paymentPurchases)
      .where(
        and(
          eq(paymentPurchases.orgId, orgId),
          eq(paymentPurchases.reference, reference),
        ),
      );
    return purchase;
  }

  /** Everything the inquiry path needs to decide whether to ask, and what. */
  async findReconciliationTarget(orgId: string, reference: string) {
    const [purchase] = await this.db
      .select({
        id: paymentPurchases.id,
        orgId: paymentPurchases.orgId,
        reference: paymentPurchases.reference,
        mode: paymentPurchases.mode,
        currency: paymentPurchases.currency,
        status: paymentPurchases.status,
        checkoutExpiresAt: paymentPurchases.checkoutExpiresAt,
        reconciliationRequired: paymentPurchases.reconciliationRequired,
        reconciliationCode: paymentPurchases.reconciliationCode,
        reconciliationAttempts: paymentPurchases.reconciliationAttempts,
        nextReconciliationAt: paymentPurchases.nextReconciliationAt,
        providerIntentionId: paymentPurchases.providerIntentionId,
        providerOrderId: paymentPurchases.providerOrderId,
        providerTransactionId: paymentPurchases.providerTransactionId,
      })
      .from(paymentPurchases)
      .where(
        and(
          eq(paymentPurchases.orgId, orgId),
          eq(paymentPurchases.reference, reference),
        ),
      );
    return purchase;
  }

  /**
   * Locks the purchase a provider event names.
   *
   * The reference is the only identifier both sides agree on before any
   * provider id is bound, and the row lock is what serializes two deliveries of
   * the same callback into one grant.
   */
  async lockByReference(tx: CreditTransaction, reference: string) {
    const [purchase] = await tx
      .select()
      .from(paymentPurchases)
      .where(eq(paymentPurchases.reference, reference))
      .for('update');
    return purchase;
  }

  /**
   * Locks a purchase only if it belongs to the named organization.
   *
   * Staff paths name both halves, and a reference from another tenant must
   * lock nothing -- the callback path's reference-only lock would let a staff
   * request pair one account with someone else's payment.
   */
  async lockForOrganization(
    tx: CreditTransaction,
    orgId: string,
    reference: string,
  ) {
    const [purchase] = await tx
      .select()
      .from(paymentPurchases)
      .where(
        and(
          eq(paymentPurchases.orgId, orgId),
          eq(paymentPurchases.reference, reference),
        ),
      )
      .for('update');
    return purchase;
  }

  async createPending(tx: CreditTransaction, input: NewPaymentPurchase) {
    const [inserted] = await tx
      .insert(paymentPurchases)
      .values({ ...input, status: 'pending', disputeStatus: 'none' })
      .onConflictDoNothing({
        target: [paymentPurchases.orgId, paymentPurchases.requestKey],
      })
      .returning();
    if (inserted) return { purchase: inserted, duplicate: false };
    const [existing] = await tx
      .select()
      .from(paymentPurchases)
      .where(
        and(
          eq(paymentPurchases.orgId, input.orgId),
          eq(paymentPurchases.requestKey, input.requestKey),
        ),
      )
      .for('update');
    if (
      !existing ||
      existing.requestHash !== input.requestHash ||
      existing.quantity !== input.quantity ||
      existing.unitPriceMinor !== input.unitPriceMinor ||
      existing.totalMinor !== input.totalMinor ||
      existing.currency !== input.currency ||
      existing.provider !== input.provider ||
      existing.mode !== input.mode
    ) {
      throw new PaymentRequestConflictError();
    }
    return { purchase: existing, duplicate: true };
  }

  async lockPurchase(tx: CreditTransaction, orgId: string, purchaseId: string) {
    const [purchase] = await tx
      .select()
      .from(paymentPurchases)
      .where(
        and(
          eq(paymentPurchases.orgId, orgId),
          eq(paymentPurchases.id, purchaseId),
        ),
      )
      .for('update');
    return purchase;
  }

  async updatePurchase(
    tx: CreditTransaction,
    orgId: string,
    purchaseId: string,
    expectedStatus: NonNullable<PurchaseInsert['status']>,
    changes: PaymentPurchaseUpdate,
  ) {
    const [purchase] = await tx
      .update(paymentPurchases)
      .set({ ...changes, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(paymentPurchases.orgId, orgId),
          eq(paymentPurchases.id, purchaseId),
          eq(paymentPurchases.status, expectedStatus),
        ),
      )
      .returning();
    if (!purchase) throw new Error('Payment purchase state conflict');
    return purchase;
  }

  async recordEvent(tx: CreditTransaction, input: EventInsert) {
    const [event] = await tx
      .insert(paymentProviderEvents)
      .values({
        orgId: input.orgId,
        purchaseId: input.purchaseId,
        provider: input.provider,
        providerIntentionId: input.providerIntentionId,
        providerOrderId: input.providerOrderId,
        providerTransactionId: input.providerTransactionId,
        fingerprint: input.fingerprint,
        payloadHash: input.payloadHash,
        verified: input.verified,
        resultCode: input.resultCode,
        errorCode: input.errorCode,
        retryCount: input.retryCount,
        nextRetryAt: input.nextRetryAt,
        processedAt: input.processedAt,
      })
      .onConflictDoNothing({
        target: [
          paymentProviderEvents.provider,
          paymentProviderEvents.fingerprint,
        ],
      })
      .returning();
    return event;
  }
}
