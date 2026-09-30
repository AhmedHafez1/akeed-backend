import {
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
