import { buildDispatchKey } from './repositories/verification-message-dispatches.repository';
import {
  creditLedgerType,
  paymentPurchaseStatus,
  paymentDisputeStatus,
} from './schema';

describe('credit domain contracts', () => {
  it('retains the default dispatch identity and supports explicit generations', () => {
    expect(buildDispatchKey('verification', 'initial')).toBe(
      'verification:initial:1',
    );
    expect(buildDispatchKey('verification', 'follow_up', 2)).toBe(
      'verification:follow_up:2',
    );
  });
  it.each([0, -1, 1.1, NaN, Infinity, 2147483648])(
    'rejects invalid generation %s',
    (generation) => {
      expect(() =>
        buildDispatchKey('verification', 'initial', generation),
      ).toThrow();
    },
  );
  it('uses only approved financial states and ledger types', () => {
    expect(creditLedgerType.enumValues).toEqual([
      'free_grant',
      'purchase',
      'consumption',
      'failure_reversal',
      'refund_reversal',
      'chargeback_reversal',
      'chargeback_reinstatement',
      'staff_adjustment',
    ]);
    expect(paymentPurchaseStatus.enumValues).toEqual([
      'pending',
      'successful',
      'failed',
      'canceled',
      'expired',
      'refunded',
    ]);
    expect(paymentDisputeStatus.enumValues).toEqual([
      'none',
      'open',
      'lost',
      'won',
    ]);
  });
});
