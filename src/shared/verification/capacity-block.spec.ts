import { isBlockedOrderStale, isCapacityBlockReason } from './capacity-block';
import {
  AUTOMATION_FINAL_STATUSES,
  isRetryableVerificationReason,
} from './verification-lifecycle';

describe('capacity block vocabulary', () => {
  it('treats only capacity refusals as a block', () => {
    expect(isCapacityBlockReason('plan_limit_reached')).toBe(true);
    expect(isCapacityBlockReason('INSUFFICIENT_CREDITS')).toBe(true);
    expect(isCapacityBlockReason('CREDIT_DEBT_OUTSTANDING')).toBe(true);
    expect(isCapacityBlockReason('CREDIT_ACCOUNT_SUSPENDED')).toBe(false);
    expect(isCapacityBlockReason('billing_not_active')).toBe(false);
    expect(isCapacityBlockReason(null)).toBe(false);
  });

  it('never lets automation remind about or escalate a blocked order', () => {
    expect(AUTOMATION_FINAL_STATUSES).toContain('blocked');
  });

  it('keeps a stale block retryable by the merchant', () => {
    expect(isRetryableVerificationReason('capacity_block_stale')).toBe(true);
  });
});

describe('isBlockedOrderStale', () => {
  const now = new Date('2026-10-22T12:00:00.000Z');

  it('is fresh up to the limit and stale after it', () => {
    expect(isBlockedOrderStale('2026-10-21T12:00:00.000Z', 24, now)).toBe(
      false,
    );
    expect(isBlockedOrderStale('2026-10-21T11:59:59.000Z', 24, now)).toBe(true);
  });

  it('treats an unknown creation time as stale', () => {
    expect(isBlockedOrderStale(null, 24, now)).toBe(true);
    expect(isBlockedOrderStale('not a date', 24, now)).toBe(true);
  });
});
