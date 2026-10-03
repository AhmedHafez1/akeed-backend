import {
  outcomeActionFor,
  selectOutcomeSync,
  toRemoteSync,
  type OutcomeSyncRow,
} from './outcome-sync';

function row(overrides: Partial<OutcomeSyncRow> = {}): OutcomeSyncRow {
  return {
    correlationId: 'verification-1',
    action: 'customer_confirmation',
    state: 'succeeded',
    errorCode: null,
    requiresAssistance: false,
    retryInBackground: true,
    updatedAt: '2026-10-03T10:00:00.000Z',
    ...overrides,
  };
}

describe('outcomeActionFor', () => {
  it.each([
    ['confirmed', null, 'customer_confirmation'],
    ['canceled', null, 'customer_cancellation'],
    ['canceled', 'customer', 'customer_cancellation'],
    ['canceled', 'merchant_no_reply', 'merchant_no_reply_cancellation'],
    ['no_reply', null, 'automatic_no_reply_tagging'],
    ['sent', null, null],
    ['failed', null, null],
    [null, null, null],
  ])('%s / %s -> %s', (status, source, action) => {
    expect(outcomeActionFor(status, source)).toBe(action);
  });
});

describe('selectOutcomeSync', () => {
  const rows = [
    row({ action: 'automatic_no_reply_tagging', state: 'unsupported' }),
    row({ action: 'merchant_no_reply_cancellation' }),
    row({ action: 'merchant_cancellation_tagging', state: 'unsupported' }),
    row({ correlationId: 'verification-2', state: 'failed' }),
  ];

  it('picks the row of the current local result, not the latest one', () => {
    expect(
      selectOutcomeSync(
        {
          id: 'verification-1',
          status: 'canceled',
          cancellationSource: 'merchant_no_reply',
        },
        rows,
      ),
    ).toMatchObject({
      action: 'merchant_no_reply_cancellation',
      state: 'succeeded',
    });
    expect(
      selectOutcomeSync(
        { id: 'verification-1', status: 'no_reply', cancellationSource: null },
        rows,
      ),
    ).toMatchObject({ state: 'unsupported' });
  });

  it('never borrows another verification’s row', () => {
    expect(
      selectOutcomeSync(
        { id: 'verification-1', status: 'confirmed', cancellationSource: null },
        rows,
      ),
    ).toBeUndefined();
  });

  it('has nothing to report before there is a local result', () => {
    expect(
      selectOutcomeSync(
        { id: 'verification-1', status: 'sent', cancellationSource: null },
        rows,
      ),
    ).toBeUndefined();
  });
});

describe('toRemoteSync', () => {
  it('offers a retry only for a failed customer-driven sync', () => {
    expect(toRemoteSync(row({ state: 'failed' })).retryable).toBe(true);
    expect(toRemoteSync(row({ state: 'pending' })).retryable).toBe(false);
    expect(
      toRemoteSync(row({ state: 'failed', retryInBackground: false }))
        .retryable,
    ).toBe(false);
  });

  it('exposes codes only', () => {
    expect(
      toRemoteSync(
        row({
          state: 'failed',
          errorCode: 'credentials_rejected',
          requiresAssistance: true,
        }),
      ),
    ).toEqual({
      state: 'failed',
      action: 'customer_confirmation',
      error_code: 'credentials_rejected',
      requires_assistance: true,
      retryable: true,
      updated_at: '2026-10-03T10:00:00.000Z',
    });
  });
});
