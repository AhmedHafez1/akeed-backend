import { shippingFailureForOutcome } from './shipping-send-outcome';

describe('shippingFailureForOutcome', () => {
  it.each([
    [{ status: 'sent' as const }, null],
    [{ status: 'sent_untracked' as const }, null],
    [{ status: 'recovery_pending' as const }, null],
    [{ status: 'outcome_unknown' as const }, null],
    [{ status: 'skipped' as const, reason: 'dispatch_in_progress' }, null],
    [{ status: 'skipped' as const, reason: 'recovery_finished' }, null],
    [{ status: 'failed' as const, reason: 'no_whatsapp' }, 'not_on_whatsapp'],
    [
      { status: 'failed' as const, reason: 'provider_not_accepted' },
      'send_failed',
    ],
    [{ status: 'skipped' as const, reason: 'no_phone' }, 'no_phone'],
    [{ status: 'skipped' as const, reason: 'allowance_low' }, 'allowance_low'],
    [{ status: 'skipped' as const, reason: 'no_allowance' }, 'no_allowance'],
    [
      { status: 'skipped' as const, reason: 'billing_not_active' },
      'no_allowance',
    ],
    [{ status: 'plan_limit_reached' as const }, 'no_allowance'],
    [
      { status: 'skipped' as const, reason: 'template_unavailable' },
      'template_unavailable',
    ],
    [
      { status: 'skipped' as const, reason: 'verification_closed' },
      'order_cancelled',
    ],
    [
      { status: 'skipped' as const, reason: 'shipping_prepaid_unsupported' },
      'send_failed',
    ],
    [{ status: 'skipped' as const }, 'send_failed'],
  ])('%j → %s', (result, expected) => {
    expect(shippingFailureForOutcome(result)).toBe(expected);
  });
});
