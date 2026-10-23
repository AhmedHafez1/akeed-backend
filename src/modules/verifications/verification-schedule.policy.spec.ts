import {
  resolveAutoCancelView,
  resolveFollowUpScheduledFor,
  resolveHeldScheduledFor,
  resolveScheduledFor,
  type ScheduleSource,
} from './verification-schedule.policy';

const NOW = new Date('2026-05-01T03:00:00.000Z'); // 06:00 in Riyadh
const LATER = '2026-05-01T05:00:00.000Z';
const EARLIER = '2026-05-01T02:00:00.000Z';

const source: ScheduleSource = {
  followUpEnabled: true,
  quietHoursEnabled: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: 'Asia/Riyadh',
};
const quietNight: ScheduleSource = {
  ...source,
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '09:00',
};

describe('resolveScheduledFor', () => {
  it('reports a held-back first message until its time passes', () => {
    const row = { status: 'pending', nextRetryAt: LATER };
    expect(resolveScheduledFor(row, NOW)).toBe(LATER);
    expect(resolveScheduledFor({ ...row, nextRetryAt: EARLIER }, NOW)).toBe(
      null,
    );
  });

  it('is null for a fresh pending row and once anything was sent', () => {
    expect(resolveScheduledFor({ status: 'pending' }, NOW)).toBeNull();
    expect(
      resolveScheduledFor(
        { status: 'pending', nextRetryAt: LATER, lastSentAt: EARLIER },
        NOW,
      ),
    ).toBeNull();
    expect(
      resolveScheduledFor({ status: 'sent', nextRetryAt: LATER }, NOW),
    ).toBeNull();
  });
});

describe('resolveHeldScheduledFor', () => {
  it('gives a queued import the end of quiet hours while they pause it', () => {
    expect(resolveHeldScheduledFor('queued', quietNight, NOW)).toBe(
      '2026-05-01T06:00:00.000Z',
    );
  });

  it('is null outside quiet hours, for other stages, or without a source', () => {
    expect(resolveHeldScheduledFor('queued', source, NOW)).toBeNull();
    expect(resolveHeldScheduledFor('awaiting_start', quietNight, NOW)).toBe(
      null,
    );
    expect(resolveHeldScheduledFor('sending', quietNight, NOW)).toBeNull();
    expect(resolveHeldScheduledFor('queued', undefined, NOW)).toBeNull();
  });
});

describe('resolveFollowUpScheduledFor', () => {
  const awaiting = {
    status: 'delivered',
    followUpAttempts: 0,
    followUpSentAt: null,
    metadata: { follow_up_due_at: LATER },
  };

  it('reports the reminder still due for an unanswered message', () => {
    expect(resolveFollowUpScheduledFor(awaiting, source, NOW)).toBe(LATER);
  });

  it.each([
    ['answered', { status: 'confirmed' }],
    ['not sent yet', { status: 'pending' }],
    ['reminder attempted', { followUpAttempts: 1 }],
    ['reminder sent', { followUpSentAt: EARLIER }],
    [
      'reminder skipped',
      { metadata: { follow_up_due_at: LATER, follow_up_skipped: 'x' } },
    ],
    [
      'reminder failed',
      { metadata: { follow_up_due_at: LATER, follow_up_failed: 'x' } },
    ],
    ['time passed', { metadata: { follow_up_due_at: EARLIER } }],
    ['no time recorded', { metadata: null }],
  ])('is null when %s', (_label, patch) => {
    expect(
      resolveFollowUpScheduledFor({ ...awaiting, ...patch }, source, NOW),
    ).toBeNull();
  });

  it('is null when reminders were turned off or the source is unknown', () => {
    expect(
      resolveFollowUpScheduledFor(
        awaiting,
        { ...source, followUpEnabled: false },
        NOW,
      ),
    ).toBeNull();
    expect(resolveFollowUpScheduledFor(awaiting, undefined, NOW)).toBeNull();
  });
});

describe('resolveAutoCancelView', () => {
  const autoCancelSource = {
    ...source,
    followUpEnabled: false,
    autoCancelEnabled: true,
    escalationEnabled: true,
    escalationDelayMinutes: 2880,
  };
  const awaiting = {
    status: 'delivered',
    lastSentAt: '2026-05-01T00:00:00.000Z',
    deliveredAt: '2026-05-01T00:01:00.000Z',
  };

  it('shows nothing for a store that does not cancel automatically', () => {
    expect(
      resolveAutoCancelView(awaiting, source, undefined, false, NOW),
    ).toBeNull();
  });

  it('projects the escalation time for an order still awaiting a reply', () => {
    expect(
      resolveAutoCancelView(awaiting, autoCancelSource, undefined, false, NOW),
    ).toEqual({
      state: 'projected',
      scheduled_for: '2026-05-03T00:00:00.000Z',
      reason: null,
      excluded: false,
      late_reply: false,
    });
  });

  it('projects nothing for an excluded order or one the customer wrote about', () => {
    expect(
      resolveAutoCancelView(
        { ...awaiting, autoCancelExcludedAt: EARLIER },
        autoCancelSource,
        undefined,
        false,
        NOW,
      ),
    ).toMatchObject({ scheduled_for: null, excluded: true });
    expect(
      resolveAutoCancelView(
        { ...awaiting, customerLastMessageAt: EARLIER },
        autoCancelSource,
        undefined,
        false,
        NOW,
      ),
    ).toMatchObject({ scheduled_for: null });
  });

  it('reports a decided row as it is, with its late-reply flag', () => {
    expect(
      resolveAutoCancelView(
        { status: 'canceled' },
        autoCancelSource,
        {
          status: 'succeeded',
          dueAt: null,
          reason: null,
          lateReplyAt: LATER,
        },
        false,
        NOW,
      ),
    ).toEqual({
      state: 'succeeded',
      scheduled_for: null,
      reason: null,
      excluded: false,
      late_reply: true,
    });
    expect(
      resolveAutoCancelView(
        { status: 'no_reply' },
        autoCancelSource,
        { status: 'scheduled', dueAt: LATER, reason: null, lateReplyAt: null },
        false,
        NOW,
      ),
    ).toMatchObject({ state: 'scheduled', scheduled_for: LATER });
  });

  it('shows nothing for a test order', () => {
    expect(
      resolveAutoCancelView(awaiting, autoCancelSource, undefined, true, NOW),
    ).toBeNull();
  });
});
