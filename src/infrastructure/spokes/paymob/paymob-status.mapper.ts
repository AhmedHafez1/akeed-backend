import { createHash } from 'node:crypto';
import type {
  NormalizedProviderEvent,
  PaymentMode,
  ProviderEventSource,
  PurchaseSignal,
} from '../../../shared/ports/payments.port';

/**
 * Translates a Paymob transaction object into the provider-neutral fact the
 * billing module acts on.
 *
 * This is the only place that knows what Paymob's booleans mean. Everything
 * downstream sees a `PurchaseSignal` and could as easily have come from another
 * processor.
 */

export const PAYMOB_PROVIDER = 'paymob';

export class UnsupportedPaymobEventError extends Error {
  constructor(readonly eventType: string) {
    super(`Paymob event type ${eventType} is not a transaction`);
  }
}

export interface PaymobCallbackEnvelope {
  type?: unknown;
  obj?: unknown;
}

interface PaymobTransaction {
  id: unknown;
  order: unknown;
  success: unknown;
  pending: unknown;
  is_refunded: unknown;
  is_voided: unknown;
  error_occured: unknown;
  amount_cents: unknown;
  currency: unknown;
  integration_id: unknown;
  created_at: unknown;
  has_parent_transaction: unknown;
  data?: unknown;
  payment_key_claims?: unknown;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function integer(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed)
    ? parsed
    : undefined;
}

function flag(value: unknown): boolean {
  return value === true || value === 'true';
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/** Paymob nests the merchant's `special_reference` under the payment claims. */
function specialReference(transaction: PaymobTransaction): string | undefined {
  const claims = record(transaction.payment_key_claims);
  const extra = record(claims.extra);
  return (
    text(claims.special_reference) ??
    text(extra.special_reference) ??
    text(record(transaction.order).merchant_order_id)
  );
}

function orderId(transaction: PaymobTransaction): string | undefined {
  const order = transaction.order;
  return order !== null && typeof order === 'object'
    ? text((order as Record<string, unknown>).id)
    : text(order);
}

/**
 * What this transaction means for the purchase.
 *
 * Order matters: a refunded or voided transaction still reports `success: true`
 * because the original authorization did succeed, so those flags are read
 * first. `has_parent_transaction` is the last refund tell, for the refund
 * transaction Paymob raises against the original.
 *
 * Chargebacks are absent on purpose. Paymob's dispute payload shape is not
 * verified against a live account, so nothing here invents one; the state
 * machine and the ledger already accept dispute signals, and US-04.5-06 wires
 * the source once the contract is captured.
 */
export function paymobSignal(transaction: PaymobTransaction): PurchaseSignal {
  if (flag(transaction.is_refunded)) return 'refund';
  if (flag(transaction.is_voided)) return 'void';
  if (flag(transaction.has_parent_transaction)) return 'refund';
  if (flag(transaction.pending)) return 'pending';
  if (flag(transaction.success)) return 'success';
  return 'decline';
}

const SAFE_CODE = /[^a-z0-9_]+/g;

/** A short, sanitized decline reason safe for a CHECK-constrained column. */
export function paymobErrorCode(
  transaction: PaymobTransaction,
): string | undefined {
  const data = record(transaction.data);
  const raw = text(data.txn_response_code) ?? text(data.message);
  if (!raw) return undefined;
  const code = raw.toLowerCase().replace(SAFE_CODE, '_').replace(/^_|_$/g, '');
  return code ? code.slice(0, 80) : undefined;
}

/**
 * Identity of a provider fact, derived from provider data only.
 *
 * The arrival channel is deliberately excluded, so the same transaction seen
 * through a callback and through an inquiry produces the same fingerprint and
 * the second one is a proven replay rather than a second grant.
 */
export function paymobFingerprint(
  parts: (string | number | boolean)[],
): string {
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

export interface PaymobMappingOptions {
  source: ProviderEventSource;
  mode: PaymentMode;
  /**
   * The reference the caller already knows.
   *
   * Only for an inquiry, which was made *by* reference: the answer is about a
   * purchase we named, so it is not something the payload has to prove. A
   * callback never passes this -- an unsolicited event that cannot say which
   * purchase it belongs to must stay unmatched.
   */
  reference?: string;
}

export function mapPaymobCallback(
  envelope: PaymobCallbackEnvelope,
  options: PaymobMappingOptions,
): NormalizedProviderEvent {
  const type = text(envelope.type) ?? 'unknown';
  if (type.toUpperCase() !== 'TRANSACTION')
    throw new UnsupportedPaymobEventError(type);
  const transaction = record(envelope.obj) as unknown as PaymobTransaction;

  const reference = specialReference(transaction) ?? options.reference;
  const amountMinor = integer(transaction.amount_cents);
  const currency = text(transaction.currency);
  const integrationId = text(transaction.integration_id);
  const transactionId = text(transaction.id);
  if (!reference || amountMinor === undefined || !currency || !integrationId)
    throw new UnsupportedPaymobEventError(type);

  const signal = paymobSignal(transaction);
  const data = record(transaction.data);
  const refundedMinorTotal =
    signal === 'refund'
      ? (integer(data.refunded_amount_cents) ?? amountMinor)
      : undefined;

  return {
    provider: PAYMOB_PROVIDER,
    source: options.source,
    reference,
    signal,
    payment: {
      reference,
      providerOrderId: orderId(transaction),
      providerTransactionId: transactionId,
      // The callback carries no intention id; it is bound when the intention
      // is created and is immutable from then on.
    },
    amountMinor,
    currency: currency.toUpperCase(),
    integrationId,
    mode: options.mode,
    refundedMinorTotal,
    // A refund is keyed on the refund transaction itself: it is the one
    // identifier Paymob repeats if it redelivers the same refund.
    sourceReference: signal === 'refund' ? transactionId : undefined,
    fingerprint: paymobFingerprint([
      PAYMOB_PROVIDER,
      signal,
      transactionId ?? '',
      orderId(transaction) ?? '',
      reference,
      flag(transaction.success),
      flag(transaction.pending),
      flag(transaction.is_refunded),
      flag(transaction.is_voided),
      flag(transaction.error_occured),
      amountMinor,
      currency,
      integrationId,
      refundedMinorTotal ?? '',
      text(transaction.created_at) ?? '',
    ]),
    payloadHash: createHash('sha256')
      .update(JSON.stringify(envelope), 'utf8')
      .digest('hex'),
    errorCode: signal === 'decline' ? paymobErrorCode(transaction) : undefined,
  };
}
