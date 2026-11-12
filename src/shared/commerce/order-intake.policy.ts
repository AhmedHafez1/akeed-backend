/**
 * Rules for the per-store order intake counts that admin health reads: how
 * many orders arrived, how many could be confirmed, and why the rest were
 * skipped. Only counts, skip codes and payment-method names are kept, never
 * customer data.
 */

/** Intake rows older than this are deleted by the hourly retention job. */
export const ORDER_INTAKE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Distinct payment-method names kept per hour; the rest count as `other`. */
export const ORDER_INTAKE_MAX_PAYMENT_METHODS = 10;
export const ORDER_INTAKE_OTHER_PAYMENT_METHOD = 'other';
export const ORDER_INTAKE_UNKNOWN_PAYMENT_METHOD = 'unknown';

const MAX_KEY_LENGTH = 80;

export type OrderIntakeOutcome = 'eligible' | 'skipped';

export interface OrderIntakeRecord {
  integrationId: string;
  externalOrderId: string;
  receivedAt: Date;
  outcome: OrderIntakeOutcome;
  /** The skip code recorded on the event; null for an eligible order. */
  skipReason: string | null;
  paymentMethod: string | null | undefined;
}

/**
 * The name a store gives its payment method (a Shopify gateway such as
 * "Cash on Delivery (COD)" or "manual"), trimmed and bounded.
 */
export function normalizeIntakePaymentMethod(
  name: string | null | undefined,
): string {
  const value =
    typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  return value
    ? value.slice(0, MAX_KEY_LENGTH)
    : ORDER_INTAKE_UNKNOWN_PAYMENT_METHOD;
}

export function normalizeIntakeSkipReason(reason: string): string {
  return reason.trim().slice(0, MAX_KEY_LENGTH) || 'unknown';
}

/** The UTC hour an order is counted in. */
export function intakeBucketStart(receivedAt: Date): Date {
  const bucket = new Date(receivedAt.getTime());
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}

/** The store's own order id, or null when it is missing or not a value. */
export function intakeOrderId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}
