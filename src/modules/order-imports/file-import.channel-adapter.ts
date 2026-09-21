import type { AcceptManyInput } from '../order-ingestion/standalone-order-ingestion.types';
import { importRowKey } from '../order-ingestion/standalone-ingestion-keys';
import type { NormalizedImportOrder } from './validation/row-validator';

/** The batch identity a row borrows for its generated order number. */
export interface ImportCommitBatch {
  id: string;
  shortCode: string;
}

/** A validated `ready` row, as the commit job reads it back. */
export interface ImportCommitRow {
  rowNumber: number;
  normalized: NormalizedImportOrder;
  /** `ref:<key>` when the merchant gave a reference, else null. */
  dedupeKey: string | null;
}

/**
 * Translates one reviewed import row into the canonical form the ingestion
 * command accepts.
 *
 * Like the manual form's adapter, it only translates: no persistence, no
 * envelope building, no dispatch, and nothing downstream may branch on the
 * fact that this row came from a spreadsheet.
 */
export const FileImportChannelAdapter = {
  toAcceptManyInput(
    row: ImportCommitRow,
    batch: ImportCommitBatch,
  ): AcceptManyInput {
    const { normalized } = row;
    return {
      // Namespaced to `import:<batchId>:<rowNumber>` by the ingestion service,
      // so re-running a chunk finds the event it already created.
      idempotencyKey: importRowKey(batch.id, row.rowNumber),
      order: {
        // The merchant's own reference is the external identity wherever there
        // is one, so two batches carrying the same order collide on the
        // `(integration_id, external_order_id)` index instead of duplicating.
        externalOrderId: row.dedupeKey ?? `imp:${batch.id}:${row.rowNumber}`,
        orderNumber:
          normalized.orderNumber ?? `IMP-${batch.shortCode}-${row.rowNumber}`,
        customerPhone: normalized.customerPhone ?? '',
        customerName: normalized.customerName ?? '',
        totalPrice: normalized.totalPrice ?? '',
        currency: normalized.currency ?? '',
        paymentMethod: normalized.paymentMethod,
        extras: extrasOf(normalized),
      },
      envelopeExtras: {
        importBatchId: batch.id,
        importRowNumber: row.rowNumber,
      },
    };
  },
};

/** Only the keys the row actually filled; `undefined` would widen the fingerprint. */
function extrasOf(normalized: NormalizedImportOrder) {
  const extras: NonNullable<AcceptManyInput['order']['extras']> = {};
  if (normalized.orderDate !== undefined)
    extras.orderDate = normalized.orderDate;
  if (normalized.city !== undefined) extras.city = normalized.city;
  if (normalized.address !== undefined) extras.address = normalized.address;
  if (normalized.notes !== undefined) extras.notes = normalized.notes;
  return extras;
}
