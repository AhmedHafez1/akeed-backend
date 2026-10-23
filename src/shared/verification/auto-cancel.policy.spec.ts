import {
  AUTO_CANCEL_MAX_ATTEMPTS,
  AUTO_CANCEL_RESPONSE_WINDOW_MS,
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
    quietHours: { enabled: false },
    ...overrides,
  };
}

describe('evaluateAutoCancel', () => {
  it('schedules now when every message was delivered long enough ago', () => {
    expect(evaluateAutoCancel(facts(), NOW)).toEqual({
      kind: 'schedule',
      dueAt: NOW,
    });
  });

  it('treats the confirmation as the final message when no reminder went out', () => {
    const delivered = new Date(NOW.getTime() - 2 * HOUR).toISOString();
    expect(
      evaluateAutoCancel(facts({ initialDeliveredAt: delivered }), NOW),
    ).toEqual({
      kind: 'schedule',
      dueAt: new Date(
        new Date(delivered).getTime() + AUTO_CANCEL_RESPONSE_WINDOW_MS,
      ),
    });
  });

  it('waits the response window after the final delivered reminder', () => {
    const reminderDelivered = new Date(NOW.getTime() - 3 * HOUR).toISOString();
    const decision = evaluateAutoCancel(
      facts({
        followUpAttempted: true,
        followUpDeliveredAt: reminderDelivered,
      }),
      NOW,
    );
    expect(decision).toEqual({
      kind: 'schedule',
      dueAt: new Date(NOW.getTime() + 9 * HOUR),
    });
  });

  it('moves a due time inside quiet hours to their end, across midnight', () => {
    // 23:00 in Riyadh (UTC+3) is inside 22:00-09:00; it ends at 09:00 local.
    const lateEvening = new Date('2026-10-20T20:00:00.000Z');
    const decision = evaluateAutoCancel(
      facts({
        quietHours: {
          enabled: true,
          start: '22:00',
          end: '09:00',
          timezone: 'Asia/Riyadh',
        },
      }),
      lateEvening,
    );
    expect(decision).toEqual({
      kind: 'schedule',
      dueAt: new Date('2026-10-21T06:00:00.000Z'),
    });
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
