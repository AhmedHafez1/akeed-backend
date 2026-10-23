import {
  AUTO_CANCEL_MAX_ATTEMPTS,
  autoCancelRetryDelayMs,
  evaluateAutoCancel,
  projectAutoCancelAt,
  type AutoCancelFacts,
} from './auto-cancel.policy';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const HOUR = 60 * 60_000;

function facts(overrides: Partial<AutoCancelFacts> = {}): AutoCancelFacts {
  return {
    enabled: true,
    isTestOrder: false,
    status: 'no_reply',
    initialDeliveredAt: '2026-10-18T10:00:00.000Z',
    followUpAttempted: false,
    ...overrides,
  };
}

describe('evaluateAutoCancel', () => {
  it('cancels at the moment the order reached no reply', () => {
    expect(evaluateAutoCancel(facts(), NOW)).toEqual({
      kind: 'schedule',
      dueAt: NOW,
    });
  });

  it('adds no wait after a reminder delivered shortly before', () => {
    const reminderDelivered = new Date(NOW.getTime() - HOUR).toISOString();
    expect(
      evaluateAutoCancel(
        facts({
          followUpAttempted: true,
          followUpDeliveredAt: reminderDelivered,
        }),
        NOW,
      ),
    ).toEqual({ kind: 'schedule', dueAt: NOW });
  });

  it.each([
    [
      'the confirmation was never reported delivered',
      facts({ initialDeliveredAt: null }),
      'initial_not_delivered',
    ],
    [
      'the reminder was refused for the plan limit',
      facts({
        followUpAttempted: false,
        followUpBlockedReason: 'plan_limit_reached',
      }),
      'reminder_blocked',
    ],
    [
      'the reminder was refused for credits',
      facts({ followUpBlockedReason: 'INSUFFICIENT_CREDITS' }),
      'reminder_blocked',
    ],
    [
      'the reminder send failed',
      facts({
        followUpAttempted: true,
        followUpBlockedReason: 'provider_not_accepted',
      }),
      'reminder_blocked',
    ],
    [
      'the reminder delivery is unknown',
      facts({ followUpAttempted: true, followUpDeliveredAt: null }),
      'reminder_not_delivered',
    ],
  ])('pauses when %s', (_label, input, reason) => {
    expect(evaluateAutoCancel(input, NOW)).toEqual({ kind: 'pause', reason });
  });

  it.each([
    ['the store has it off', facts({ enabled: false }), 'disabled'],
    ['it is a test order', facts({ isTestOrder: true }), 'test_order'],
    [
      'the merchant excluded it',
      facts({ excludedAt: NOW.toISOString() }),
      'excluded',
    ],
    [
      'the customer confirmed',
      facts({ confirmedAt: NOW.toISOString() }),
      'already_resolved',
    ],
    [
      'the merchant canceled',
      facts({ merchantCanceledAt: NOW.toISOString() }),
      'already_resolved',
    ],
    ['the order is not at no_reply', facts({ status: 'read' }), 'not_no_reply'],
    [
      'the customer wrote anything',
      facts({ customerLastMessageAt: NOW.toISOString() }),
      'customer_replied',
    ],
  ])('skips when %s', (_label, input, reason) => {
    expect(evaluateAutoCancel(input, NOW)).toEqual({ kind: 'skip', reason });
  });

  it('never cancels for capacity, even with an undelivered order otherwise eligible', () => {
    for (const blocked of [
      'plan_limit_reached',
      'INSUFFICIENT_CREDITS',
      'CREDIT_DEBT_OUTSTANDING',
    ]) {
      expect(
        evaluateAutoCancel(facts({ followUpBlockedReason: blocked }), NOW).kind,
      ).toBe('pause');
    }
  });
});

describe('projectAutoCancelAt', () => {
  it('runs the escalation time through the same rules', () => {
    const escalation = new Date('2026-10-21T12:00:00.000Z');
    expect(projectAutoCancelAt(facts(), escalation)).toEqual(escalation);
  });

  it('projects nothing for an order that would pause', () => {
    expect(
      projectAutoCancelAt(facts({ initialDeliveredAt: null }), NOW),
    ).toBeNull();
  });
});

describe('autoCancelRetryDelayMs', () => {
  it('backs off, then gives up after the last attempt', () => {
    expect(autoCancelRetryDelayMs(1)).toBe(30_000);
    expect(autoCancelRetryDelayMs(2)).toBe(2 * 60_000);
    expect(autoCancelRetryDelayMs(4)).toBe(30 * 60_000);
    expect(autoCancelRetryDelayMs(AUTO_CANCEL_MAX_ATTEMPTS)).toBeNull();
  });
});
