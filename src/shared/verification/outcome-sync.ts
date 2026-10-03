import type {
  CommerceOutcomeAction,
  CommerceOutcomeSyncState,
} from '../commerce/commerce-outcome';

/** The part of a sync row the dashboard needs. */
export interface OutcomeSyncRow {
  correlationId: string;
  action: string;
  state: string;
  errorCode: string | null;
  requiresAssistance: boolean;
  retryInBackground: boolean;
  updatedAt: string;
}

/**
 * Whether the store has the verification's result yet. Reported next to the
 * local status, never instead of it. Absent for sources that do not track
 * synchronization.
 */
export interface RemoteSyncDto {
  state: CommerceOutcomeSyncState;
  action: CommerceOutcomeAction;
  /** A stable code the client translates; never provider text. */
  error_code: string | null;
  /** Only the merchant can clear it (a revoked key, say). */
  requires_assistance: boolean;
  /** A failed sync the merchant may ask to be tried again. */
  retryable: boolean;
  updated_at: string;
}

/**
 * The outcome action a verification's local result stands for, or null while
 * it has no result a store could be told about.
 */
export function outcomeActionFor(
  status: string | null | undefined,
  cancellationSource: string | null | undefined,
): CommerceOutcomeAction | null {
  switch (status) {
    case 'confirmed':
      return 'customer_confirmation';
    case 'canceled':
      return cancellationSource === 'merchant_no_reply'
        ? 'merchant_no_reply_cancellation'
        : 'customer_cancellation';
    case 'no_reply':
      return 'automatic_no_reply_tagging';
    default:
      return null;
  }
}

/** The row that speaks for the verification's current local result. */
export function selectOutcomeSync<Row extends OutcomeSyncRow>(
  verification: {
    id: string;
    status: string | null | undefined;
    cancellationSource: string | null | undefined;
  },
  rows: readonly Row[],
): Row | undefined {
  const action = outcomeActionFor(
    verification.status,
    verification.cancellationSource,
  );
  if (!action) return undefined;
  return rows.find(
    (row) => row.correlationId === verification.id && row.action === action,
  );
}

export function toRemoteSync(row: OutcomeSyncRow): RemoteSyncDto {
  return {
    state: row.state as CommerceOutcomeSyncState,
    action: row.action as CommerceOutcomeAction,
    error_code: row.errorCode,
    requires_assistance: row.requiresAssistance,
    retryable: row.state === 'failed' && row.retryInBackground,
    updated_at: row.updatedAt,
  };
}
