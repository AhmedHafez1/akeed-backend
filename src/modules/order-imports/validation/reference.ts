import { fitsCanonicalOrderNumber } from '../../../shared/commerce/canonical-order.rules';
import { normalizeOrderReference } from '../../order-ingestion/standalone-ingestion-keys';
import type { RowIssue } from './issue-codes';

export interface OrderReferenceResult {
  /** The reference as written, trimmed; absent when blank. */
  orderNumber?: string;
  /** `ref:<key>` from the ingestion command's shared normalizer, or null. */
  dedupeKey: string | null;
  issue?: RowIssue;
}

/**
 * The merchant's order reference (AC8). Without one, identity is assigned at
 * commit and the row takes no part in reference dedupe.
 */
export function validateOrderReference(cell: string): OrderReferenceResult {
  if (!cell) return { dedupeKey: null };
  if (!fitsCanonicalOrderNumber(cell))
    return {
      dedupeKey: null,
      issue: { code: 'ORDER_REF_TOO_LONG', field: 'orderReference' },
    };
  return { orderNumber: cell, dedupeKey: normalizeOrderReference(cell) };
}
