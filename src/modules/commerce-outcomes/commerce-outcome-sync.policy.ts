import type {
  CommerceOutcomeOperationResult,
  CommerceOutcomeSyncState,
} from '../../shared/commerce/commerce-outcome';

/** Tries a failing outcome gets before it is left for the merchant. */
export const OUTCOME_SYNC_MAX_ATTEMPTS = 5;

/**
 * Waits a provider may name ("not before the next minute") without spending
 * an attempt; after that a wait counts like any other failure.
 */
export const OUTCOME_SYNC_MAX_DEFERRALS = 5;

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_DEFERRAL_MS = 10 * 60_000;
const PROVIDER_STATUS_MAX_LENGTH = 64;

export interface OutcomeSyncProgress {
  /** Counters before this try. */
  attempts: number;
  deferrals: number;
  retryInBackground: boolean;
}

export interface OutcomeSyncPlan {
  state: CommerceOutcomeSyncState;
  errorCode: string | null;
  providerStatus: string | null;
  requiresAssistance: boolean;
  spent: 'attempt' | 'deferral';
  /** Set when the outcome is to be tried again after this long. */
  retryDelayMs: number | null;
}

/** 30 seconds, then four times longer each time, up to half an hour. */
export function outcomeSyncBackoffMs(attemptsMade: number): number {
  return Math.min(
    BASE_BACKOFF_MS * 4 ** Math.max(attemptsMade - 1, 0),
    MAX_BACKOFF_MS,
  );
}

function safeProviderStatus(
  result: CommerceOutcomeOperationResult,
): string | null {
  const status = 'providerStatus' in result ? result.providerStatus : undefined;
  return status && status.length <= PROVIDER_STATUS_MAX_LENGTH ? status : null;
}

/**
 * Turns one dispatch result into the state the merchant sees and whether the
 * outcome is tried again. Remote success is only ever reported for a result
 * the adapter confirmed.
 */
export function planOutcomeSync(
  result: CommerceOutcomeOperationResult,
  progress: OutcomeSyncProgress,
): OutcomeSyncPlan {
  const base = {
    errorCode: null,
    providerStatus: safeProviderStatus(result),
    requiresAssistance: false,
    spent: 'attempt' as const,
    retryDelayMs: null,
  };

  switch (result.status) {
    case 'applied':
    case 'accepted_without_reference':
      return { ...base, state: 'succeeded' };
    case 'pending_provider_operation':
      return { ...base, state: 'pending' };
    case 'unsupported':
      return { ...base, state: 'unsupported', errorCode: result.reason };
    case 'permanent_failure':
      return {
        ...base,
        state: 'failed',
        errorCode: result.errorCode,
        requiresAssistance: result.requiresAssistance === true,
      };
    case 'retryable_failure': {
      const failed = {
        ...base,
        state: 'failed' as const,
        errorCode: result.errorCode,
      };
      if (!progress.retryInBackground) return failed;
      if (
        result.retryAfterMs !== undefined &&
        progress.deferrals < OUTCOME_SYNC_MAX_DEFERRALS
      )
        return {
          ...failed,
          state: 'pending',
          spent: 'deferral',
          retryDelayMs: Math.min(
            Math.max(Math.ceil(result.retryAfterMs), 0),
            MAX_DEFERRAL_MS,
          ),
        };
      const attemptsMade = progress.attempts + 1;
      if (attemptsMade >= OUTCOME_SYNC_MAX_ATTEMPTS) return failed;
      return {
        ...failed,
        state: 'pending',
        retryDelayMs: outcomeSyncBackoffMs(attemptsMade),
      };
    }
  }
}
