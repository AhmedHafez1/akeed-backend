import type { OrderImportReleaseStateDto } from '../dto/order-import-release.dto';

type LifecycleBucket = keyof OrderImportReleaseStateDto['lifecycle'];

/**
 * How the dashboard lifecycle statuses fold into the releasing view's pills
 * (M8). Queued covers everything not yet sent, including held orders; failed
 * covers everything that needs the merchant's attention.
 */
const BUCKET_BY_STATUS: Record<string, LifecycleBucket> = {
  awaiting_start: 'queued',
  accepted: 'queued',
  processing: 'queued',
  pending: 'queued',
  sent: 'sent',
  delivered: 'sent',
  read: 'sent',
  confirmed: 'confirmed',
  canceled: 'canceled',
  no_reply: 'noReply',
  failed: 'failed',
  blocked: 'failed',
  ineligible: 'failed',
  expired: 'failed',
  review_required: 'failed',
};

/** `not_started` (withdrawn) orders were never contacted and are not counted. */
export function lifecycleBuckets(
  rows: Array<{ status: string; count: number }>,
): OrderImportReleaseStateDto['lifecycle'] {
  const buckets: OrderImportReleaseStateDto['lifecycle'] = {
    queued: 0,
    sent: 0,
    confirmed: 0,
    canceled: 0,
    noReply: 0,
    failed: 0,
  };
  for (const row of rows) {
    const bucket = BUCKET_BY_STATUS[row.status];
    if (bucket) buckets[bucket] += row.count;
  }
  return buckets;
}
