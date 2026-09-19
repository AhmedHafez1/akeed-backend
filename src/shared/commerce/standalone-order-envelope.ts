import { createHash } from 'node:crypto';
import type { CodStatus } from '../interfaces/commerce-source.interface';
import { appendPaymentSignal, classifyCodStatus } from './payment-signals';

/**
 * Every channel a Standalone order can enter through. All of them share one
 * envelope, one normalizer and one eligibility strategy; `ingestionType` is
 * audit metadata only and nothing downstream of the normalizer reads it.
 * E05 appends `'api'` here.
 */
export const STANDALONE_INGESTION_CHANNELS = ['manual', 'bulk_import'] as const;

export type StandaloneIngestionChannel =
  (typeof STANDALONE_INGESTION_CHANNELS)[number];

export function isStandaloneIngestionChannel(
  value: unknown,
): value is StandaloneIngestionChannel {
  return (STANDALONE_INGESTION_CHANNELS as readonly unknown[]).includes(value);
}

export const STANDALONE_ENVELOPE_SCHEMA_VERSION = 1;

/**
 * The canonical order fields that must be non-empty strings. The builder
 * writes them and the normalizer requires them, so the two read this one list
 * and cannot drift apart.
 */
export const CANONICAL_ORDER_REQUIRED_FIELDS = [
  'externalOrderId',
  'orderNumber',
  'customerName',
  'customerPhone',
  'totalPrice',
  'currency',
] as const;

/** Optional order details a channel may carry; stored, never sent. */
export interface CanonicalOrderExtras {
  orderDate?: string;
  city?: string;
  address?: string;
  notes?: string;
}

/**
 * What every Standalone channel adapter translates its input into.
 * `customerPhone` is already E.164; `totalPrice` is a positive decimal string.
 */
export interface CanonicalOrderInput {
  externalOrderId: string;
  orderNumber: string;
  customerPhone: string;
  customerName: string;
  totalPrice: string;
  currency: string;
  paymentMethod: string;
  extras?: CanonicalOrderExtras;
}

export interface CanonicalOrder extends CanonicalOrderExtras {
  externalOrderId: string;
  orderNumber: string;
  customerPhone: string;
  customerName: string;
  totalPrice: string;
  currency: string;
  paymentMethod: string;
  paymentSignals: string[];
  codStatus: CodStatus;
}

export interface StandaloneOrderEnvelope {
  canonicalOrder: CanonicalOrder;
  submissionFingerprint: string;
  rawPayload: Record<string, unknown>;
}

const EXTRA_FIELDS = [
  'orderDate',
  'city',
  'address',
  'notes',
] as const satisfies ReadonlyArray<keyof CanonicalOrderExtras>;

const RESERVED_ENVELOPE_KEYS: readonly string[] = [
  'ingestionType',
  'schemaVersion',
  'submissionFingerprint',
  'order',
];

/**
 * Hash of the canonical order as serialized. Stored manual events are
 * deduplicated against it, so key order is part of the contract: changing it
 * turns every existing retry into an idempotency conflict.
 */
export function fingerprintCanonicalOrder(order: CanonicalOrder): string {
  return createHash('sha256').update(JSON.stringify(order)).digest('hex');
}

/**
 * The single place a Standalone `rawPayload` is built.
 *
 * `extras` is channel metadata (for example the import batch and row) placed
 * beside the order, outside the fingerprint. Order extras are appended after
 * the fixed fields only when present, so an order without them serializes
 * exactly as manual orders always have.
 */
export function buildStandaloneOrderEnvelope(params: {
  ingestionType: StandaloneIngestionChannel;
  order: CanonicalOrderInput;
  extras?: Record<string, unknown>;
}): StandaloneOrderEnvelope {
  const { order } = params;
  const reserved = Object.keys(params.extras ?? {}).filter((key) =>
    RESERVED_ENVELOPE_KEYS.includes(key),
  );
  if (reserved.length > 0) {
    throw new Error(`envelope extras may not set: ${reserved.join(', ')}`);
  }
  const paymentSignals: string[] = [];
  appendPaymentSignal(paymentSignals, order.paymentMethod);
  const canonicalOrder: CanonicalOrder = {
    externalOrderId: order.externalOrderId,
    orderNumber: order.orderNumber,
    customerPhone: order.customerPhone,
    customerName: order.customerName,
    totalPrice: Number(order.totalPrice).toFixed(2),
    currency: order.currency,
    paymentMethod: order.paymentMethod,
    paymentSignals,
    codStatus: classifyCodStatus(paymentSignals),
  };
  for (const field of EXTRA_FIELDS) {
    const value = order.extras?.[field];
    if (value !== undefined) canonicalOrder[field] = value;
  }
  const submissionFingerprint = fingerprintCanonicalOrder(canonicalOrder);
  return {
    canonicalOrder,
    submissionFingerprint,
    rawPayload: {
      ingestionType: params.ingestionType,
      schemaVersion: STANDALONE_ENVELOPE_SCHEMA_VERSION,
      submissionFingerprint,
      ...(params.extras ?? {}),
      order: canonicalOrder,
    },
  };
}
