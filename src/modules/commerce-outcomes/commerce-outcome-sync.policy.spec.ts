import type { CommerceOutcomeOperationResult } from '../../shared/commerce/commerce-outcome';
import {
  OUTCOME_SYNC_MAX_ATTEMPTS,
  OUTCOME_SYNC_MAX_DEFERRALS,
  outcomeSyncBackoffMs,
  planOutcomeSync,
} from './commerce-outcome-sync.policy';

const fresh = { attempts: 0, deferrals: 0, retryInBackground: true };

describe('planOutcomeSync', () => {
  it.each<CommerceOutcomeOperationResult>([
    { status: 'applied' },
    { status: 'accepted_without_reference' },
  ])('reports success only for a confirmed result ($status)', (result) => {
    expect(planOutcomeSync(result, fresh)).toMatchObject({
      state: 'succeeded',
      errorCode: null,
      retryDelayMs: null,
      spent: 'attempt',
    });
  });

  it('keeps an operation the provider is still working on as pending', () => {
    expect(
      planOutcomeSync(
        { status: 'pending_provider_operation', providerOperationId: 'job-1' },
        fresh,
      ),
    ).toMatchObject({ state: 'pending', retryDelayMs: null });
  });

  it('records an unsupported action with its reason and never retries it', () => {
    expect(
      planOutcomeSync(
        { status: 'unsupported', reason: 'capability_not_supported' },
        fresh,
      ),
    ).toMatchObject({
      state: 'unsupported',
      errorCode: 'capability_not_supported',
      retryDelayMs: null,
    });
  });

  it('stops at a permanent failure and carries the assisted-action flag', () => {
    expect(
      planOutcomeSync(
        {
          status: 'permanent_failure',
          errorCode: 'credentials_rejected',
          requiresAssistance: true,
        },
        fresh,
      ),
    ).toMatchObject({
      state: 'failed',
      errorCode: 'credentials_rejected',
      requiresAssistance: true,
      retryDelayMs: null,
    });
  });

  it('does not retry behind a caller that did not ask for it', () => {
    expect(
      planOutcomeSync(
        { status: 'retryable_failure', errorCode: 'source_unavailable' },
        { ...fresh, retryInBackground: false },
      ),
    ).toMatchObject({
      state: 'failed',
      errorCode: 'source_unavailable',
      retryDelayMs: null,
    });
  });

  it('backs off a transient failure and spends an attempt', () => {
    expect(
      planOutcomeSync(
        { status: 'retryable_failure', errorCode: 'source_unavailable' },
        { ...fresh, attempts: 1 },
      ),
    ).toMatchObject({
      state: 'pending',
      errorCode: 'source_unavailable',
      spent: 'attempt',
      retryDelayMs: outcomeSyncBackoffMs(2),
    });
  });

  it('fails visibly once the attempts are used up', () => {
    expect(
      planOutcomeSync(
        { status: 'retryable_failure', errorCode: 'source_unavailable' },
        { ...fresh, attempts: OUTCOME_SYNC_MAX_ATTEMPTS - 1 },
      ),
    ).toMatchObject({ state: 'failed', retryDelayMs: null });
  });

  it('waits as long as the provider named without spending an attempt', () => {
    expect(
      planOutcomeSync(
        {
          status: 'retryable_failure',
          errorCode: 'source_rate_limited',
          retryAfterMs: 41_000,
        },
        { ...fresh, attempts: OUTCOME_SYNC_MAX_ATTEMPTS - 1 },
      ),
    ).toMatchObject({
      state: 'pending',
      spent: 'deferral',
      retryDelayMs: 41_000,
    });
  });

  it('caps a named wait at ten minutes', () => {
    expect(
      planOutcomeSync(
        {
          status: 'retryable_failure',
          errorCode: 'source_rate_limited',
          retryAfterMs: 3_600_000,
        },
        fresh,
      ).retryDelayMs,
    ).toBe(600_000);
  });

  it('counts a wait as an attempt once the deferrals are used up', () => {
    const result: CommerceOutcomeOperationResult = {
      status: 'retryable_failure',
      errorCode: 'source_rate_limited',
      retryAfterMs: 41_000,
    };
    expect(
      planOutcomeSync(result, {
        ...fresh,
        deferrals: OUTCOME_SYNC_MAX_DEFERRALS,
      }),
    ).toMatchObject({ state: 'pending', spent: 'attempt' });
    expect(
      planOutcomeSync(result, {
        retryInBackground: true,
        deferrals: OUTCOME_SYNC_MAX_DEFERRALS,
        attempts: OUTCOME_SYNC_MAX_ATTEMPTS - 1,
      }),
    ).toMatchObject({ state: 'failed', retryDelayMs: null });
  });

  it('keeps a short provider status and drops an implausible one', () => {
    expect(
      planOutcomeSync(
        {
          status: 'permanent_failure',
          errorCode: 'remote_state_conflict',
          providerStatus: 'delivered',
        },
        fresh,
      ).providerStatus,
    ).toBe('delivered');
    expect(
      planOutcomeSync(
        {
          status: 'permanent_failure',
          errorCode: 'remote_state_conflict',
          providerStatus: 'x'.repeat(65),
        },
        fresh,
      ).providerStatus,
    ).toBeNull();
  });
});

describe('outcomeSyncBackoffMs', () => {
  it('grows from 30 seconds and stops at half an hour', () => {
    expect([1, 2, 3, 4, 5, 9].map(outcomeSyncBackoffMs)).toEqual([
      30_000, 120_000, 480_000, 1_800_000, 1_800_000, 1_800_000,
    ]);
  });
});
