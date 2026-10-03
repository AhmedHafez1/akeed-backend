import type { PlatformType } from '../interfaces/commerce-source.interface';

export const COMMERCE_OUTCOME_ACTIONS = [
  'customer_confirmation',
  'customer_cancellation',
  'merchant_no_reply_cancellation',
  'merchant_cancellation_tagging',
  'automatic_no_reply_tagging',
] as const;

export type CommerceOutcomeAction = (typeof COMMERCE_OUTCOME_ACTIONS)[number];

export interface CommerceOutcomeDispatchCommand {
  orgId: string;
  integrationId: string;
  externalOrderId: string;
  action: CommerceOutcomeAction;
  correlationId: string;
  /**
   * Lets a tracked adapter's retryable failure be tried again by the outcome
   * sync worker. Left unset when the caller is itself the retry, as a merchant
   * pressing a button is.
   */
  retryInBackground?: boolean;
}

export interface CommerceOutcomeConnection {
  id: string;
  orgId: string;
  platformType: string;
  platformStoreUrl: string;
  accessToken: string | null;
  isActive: boolean | null;
  metadata: unknown;
}

export interface CommerceOutcomeAdapterRequest extends CommerceOutcomeDispatchCommand {
  connection: CommerceOutcomeConnection;
}

/**
 * `providerStatus` is the remote state an adapter last saw, as an opaque
 * label for support. `retryAfterMs` is a wait the provider or its rate budget
 * named. `requiresAssistance` marks a failure only the merchant can clear
 * (revoked key, missing permission): it is never retried automatically.
 */
export type CommerceOutcomeOperationResult =
  | { status: 'applied'; providerStatus?: string }
  | { status: 'accepted_without_reference' }
  | {
      status: 'unsupported';
      reason: 'adapter_not_registered' | 'capability_not_supported';
    }
  | {
      status: 'pending_provider_operation';
      providerOperationId: string;
    }
  | {
      status: 'retryable_failure';
      errorCode: string;
      retryAfterMs?: number;
      providerStatus?: string;
    }
  | {
      status: 'permanent_failure';
      errorCode: string;
      requiresAssistance?: boolean;
      providerStatus?: string;
    };

/** What the merchant is shown about the remote side of an outcome. */
export const COMMERCE_OUTCOME_SYNC_STATES = [
  'pending',
  'succeeded',
  'failed',
  'unsupported',
] as const;

export type CommerceOutcomeSyncState =
  (typeof COMMERCE_OUTCOME_SYNC_STATES)[number];

export type CommerceOutcomeDispatchResult = CommerceOutcomeOperationResult &
  CommerceOutcomeDispatchCommand;

export interface CommerceOutcomeAdapter {
  readonly platformType: PlatformType;
  readonly capabilities: ReadonlySet<CommerceOutcomeAction>;
  readonly requiresActiveConnection: boolean;
  /**
   * True when each dispatch is recorded as a sync state and may be retried in
   * the background. Adapters that leave it unset behave as they always have.
   */
  readonly tracksSynchronization?: boolean;
  execute(
    request: CommerceOutcomeAdapterRequest,
  ): Promise<CommerceOutcomeOperationResult>;
}

export const COMMERCE_OUTCOME_ADAPTERS = Symbol('COMMERCE_OUTCOME_ADAPTERS');

export interface CancelOrderResponse {
  success: true;
  verificationId: string;
  status: 'canceled';
  alreadyCanceled?: boolean;
  providerOperationId?: string;
  operation?: CommerceOutcomeOperationResult;
}
