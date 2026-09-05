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

export type CommerceOutcomeOperationResult =
  | { status: 'applied' }
  | { status: 'accepted_without_reference' }
  | {
      status: 'unsupported';
      reason: 'adapter_not_registered' | 'capability_not_supported';
    }
  | {
      status: 'pending_provider_operation';
      providerOperationId: string;
    }
  | { status: 'retryable_failure'; errorCode: string }
  | { status: 'permanent_failure'; errorCode: string };

export type CommerceOutcomeDispatchResult = CommerceOutcomeOperationResult &
  CommerceOutcomeDispatchCommand;

export interface CommerceOutcomeAdapter {
  readonly platformType: PlatformType;
  readonly capabilities: ReadonlySet<CommerceOutcomeAction>;
  readonly requiresActiveConnection: boolean;
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
