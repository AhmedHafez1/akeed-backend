import type { StandaloneIngestionChannel } from '../../shared/commerce/standalone-order-envelope';

/**
 * Per-channel prefix on the stored `webhook_events.idempotency_key`.
 *
 * Manual keys carry no prefix: they were stored raw before channels existed,
 * and a replay must find the event it created. Every later channel is
 * namespaced so its keys cannot collide with a merchant's manual key or with
 * each other. E05 adds `api: 'api:'`.
 */
const IDEMPOTENCY_KEY_PREFIX: Record<StandaloneIngestionChannel, string> = {
  manual: '',
  bulk_import: 'import:',
};

export function namespaceIdempotencyKey(
  channel: StandaloneIngestionChannel,
  localKey: string,
): string {
  return `${IDEMPOTENCY_KEY_PREFIX[channel]}${localKey}`;
}

/** The channel-local key of one import row: `<batchId>:<rowNumber>`. */
export function importRowKey(batchId: string, rowNumber: number): string {
  return `${batchId}:${rowNumber}`;
}

/**
 * The shared external identity of a merchant's own order reference.
 *
 * File import and the E05 API both call this, so the same merchant order
 * resolves to the same `externalOrderId` whichever channel it arrives by and
 * the `(integration_id, external_order_id)` unique index dedupes it.
 * "#1001", " 1001 " and "# 10 01" are all `ref:1001`. Returns null when
 * nothing is left.
 */
export function normalizeOrderReference(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '');
  return key ? `ref:${key}` : null;
}
