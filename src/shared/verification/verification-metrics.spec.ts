import {
  buildMessageFunnel,
  rateOfSent,
  resolveUsage,
  type OverviewCounts,
} from './verification-metrics';

function counts(overrides: Partial<OverviewCounts> = {}): OverviewCounts {
  return {
    sent: 0,
    delivered: 0,
    read: 0,
    confirmed: 0,
    confirmedAfterSend: 0,
    customerConfirmedAfterSend: 0,
    customerCanceled: 0,
    customerCanceledAfterSend: 0,
    ...overrides,
  };
}

describe('rateOfSent', () => {
  it('is null when nothing was sent, so a new shop never reads 0%', () => {
    expect(rateOfSent(0, 0)).toBeNull();
    expect(rateOfSent(5, 0)).toBeNull();
  });

  it('is a one-decimal percentage of sent', () => {
    expect(rateOfSent(19, 28)).toBe(67.9);
    expect(rateOfSent(1, 3)).toBe(33.3);
  });

  it('is 0 when everything was sent but nothing confirmed (all failed)', () => {
    expect(rateOfSent(0, 12)).toBe(0);
  });

  it('never exceeds 100 or drops below 0 on defective counts', () => {
    expect(rateOfSent(30, 28)).toBe(100);
    expect(rateOfSent(-2, 28)).toBe(0);
  });
});

describe('buildMessageFunnel', () => {
  it('matches the design example: 28 sent, 19 confirmed, 6 canceled', () => {
    const funnel = buildMessageFunnel(
      counts({
        sent: 28,
        delivered: 27,
        read: 25,
        confirmedAfterSend: 19,
        customerConfirmedAfterSend: 19,
        customerCanceledAfterSend: 6,
      }),
    );

    expect(funnel.sent).toEqual({ count: 28, percent_of_sent: 100 });
    expect(funnel.delivered).toEqual({ count: 27, percent_of_sent: 96.4 });
    expect(funnel.read).toEqual({ count: 25, percent_of_sent: 89.3 });
    expect(funnel.replied).toEqual({ count: 25, percent_of_sent: 89.3 });
    expect(funnel.confirmed).toBe(19);
    expect(funnel.customer_canceled).toBe(6);
    expect(funnel.no_reply_yet).toBe(3);
  });

  it('reports an empty period as zeros with no percentages', () => {
    const funnel = buildMessageFunnel(counts());

    expect(funnel.sent).toEqual({ count: 0, percent_of_sent: null });
    expect(funnel.replied).toEqual({ count: 0, percent_of_sent: null });
    expect(funnel.no_reply_yet).toBe(0);
  });

  it('does not count a merchant confirmation as a customer reply', () => {
    const funnel = buildMessageFunnel(
      counts({ sent: 4, confirmedAfterSend: 3, customerConfirmedAfterSend: 1 }),
    );

    expect(funnel.confirmed).toBe(1);
    expect(funnel.replied.count).toBe(1);
    expect(funnel.no_reply_yet).toBe(3);
  });

  it('keeps every step at or below sent when the columns disagree', () => {
    const funnel = buildMessageFunnel(
      counts({
        sent: 2,
        delivered: 5,
        read: 4,
        customerConfirmedAfterSend: 2,
        customerCanceledAfterSend: 2,
      }),
    );

    expect(funnel.delivered.count).toBe(2);
    expect(funnel.read.count).toBe(2);
    expect(funnel.replied.count).toBe(2);
    expect(funnel.confirmed + funnel.customer_canceled).toBe(2);
    expect(funnel.no_reply_yet).toBe(0);
  });
});

describe('resolveUsage', () => {
  it('is quiet below 80%', () => {
    expect(resolveUsage(23, 30)).toEqual({
      used: 23,
      limit: 30,
      percent: 76,
      state: 'ok',
    });
  });

  it('warns from 80% up to the limit', () => {
    expect(resolveUsage(24, 30).state).toBe('warning');
    expect(resolveUsage(27, 30)).toEqual({
      used: 27,
      limit: 30,
      percent: 90,
      state: 'warning',
    });
    expect(resolveUsage(29, 30).state).toBe('warning');
  });

  it('is exhausted at or over the limit', () => {
    expect(resolveUsage(30, 30)).toEqual({
      used: 30,
      limit: 30,
      percent: 100,
      state: 'exhausted',
    });
    expect(resolveUsage(31, 30).percent).toBe(100);
  });

  it('treats a zero limit as nothing to report', () => {
    expect(resolveUsage(0, 0)).toEqual({
      used: 0,
      limit: 0,
      percent: 0,
      state: 'ok',
    });
  });
});
