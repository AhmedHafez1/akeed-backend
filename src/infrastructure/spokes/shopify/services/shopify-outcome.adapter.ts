import { Injectable } from '@nestjs/common';
import { isAxiosError } from 'axios';
import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceCancellationInspection,
  type CommerceOperationResolution,
  type CommerceOutcomeAction,
  type CommerceOutcomeAdapter,
  type CommerceOutcomeAdapterRequest,
  type CommerceOutcomeOperationResult,
} from '../../../../shared/commerce/commerce-outcome';
import { ShopifyApiService } from './shopify-api.service';
import {
  ShopifyGraphqlError,
  type ShopifyOrderCancellationState,
} from './shopify-api.service.helpers';

/** The tag each tagging outcome adds to the Shopify order. */
const OUTCOME_TAGS = {
  customer_confirmation: 'Akeed: Verified',
  customer_cancellation: 'Akeed: Canceled',
  merchant_cancellation_tagging: 'Akeed: Canceled',
  automatic_no_reply_tagging: 'Akeed: No Reply',
  automatic_no_whatsapp_tagging: 'Akeed: WhatsApp Undeliverable',
} as const satisfies Partial<Record<CommerceOutcomeAction, string>>;

type TaggingAction = keyof typeof OUTCOME_TAGS;

/** Read when Shopify names a wait in seconds or as a date. */
function retryAfterMs(header: unknown): number | undefined {
  if (typeof header !== 'string' || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 0);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(at - Date.now(), 0);
}

/**
 * Turns a failed tag write into a result the outcome sync can act on, or
 * null for an error it cannot place (the registry then treats it as
 * retryable). Tagging is idempotent, so retrying an unclear failure is safe;
 * only a failure retrying cannot fix is reported as permanent.
 */
export function classifyShopifyWriteError(
  error: unknown,
): CommerceOutcomeOperationResult | null {
  if (error instanceof ShopifyGraphqlError) {
    return error.kind === 'user'
      ? { status: 'permanent_failure', errorCode: 'remote_rejected' }
      : { status: 'retryable_failure', errorCode: 'source_unavailable' };
  }
  if (!isAxiosError(error)) return null;
  const status = error.response?.status;
  if (status === undefined)
    return { status: 'retryable_failure', errorCode: 'source_unavailable' };
  if (status === 401 || status === 403)
    return {
      status: 'permanent_failure',
      errorCode: 'credentials_rejected',
      requiresAssistance: true,
    };
  if (status === 404)
    return { status: 'permanent_failure', errorCode: 'order_not_found' };
  if (status === 429) {
    const wait = retryAfterMs(error.response?.headers?.['retry-after']);
    return {
      status: 'retryable_failure',
      errorCode: 'source_unavailable',
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    };
  }
  if (status >= 500)
    return { status: 'retryable_failure', errorCode: 'source_unavailable' };
  return null;
}

/** Financial states in which money was taken or promised. */
const PAID_FINANCIAL_STATUSES = new Set([
  'PAID',
  'PARTIALLY_PAID',
  'AUTHORIZED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);

/** Fulfillment states where the goods are, or may be, on their way. */
const SHIPPED_FULFILLMENT_STATUSES = new Set([
  'FULFILLED',
  'PARTIALLY_FULFILLED',
]);

/**
 * Reads Shopify's view of an order for an automatic cancellation. Only an
 * open order that is still `PENDING` payment and `UNFULFILLED` may be
 * canceled; any other fulfillment state means a fulfillment hold, a schedule
 * or a fulfillment service already has it.
 */
export function classifyShopifyCancellationState(
  order: ShopifyOrderCancellationState | null,
): CommerceCancellationInspection {
  if (!order) return { state: 'not_cancellable', reason: 'order_not_found' };
  const providerStatus = `${order.displayFinancialStatus ?? 'UNKNOWN'}/${order.displayFulfillmentStatus ?? 'UNKNOWN'}`;
  if (order.cancelledAt) return { state: 'already_canceled', providerStatus };
  if (PAID_FINANCIAL_STATUSES.has(order.displayFinancialStatus ?? '')) {
    return { state: 'not_cancellable', reason: 'paid', providerStatus };
  }
  if (SHIPPED_FULFILLMENT_STATUSES.has(order.displayFulfillmentStatus ?? '')) {
    return { state: 'not_cancellable', reason: 'fulfilled', providerStatus };
  }
  if (order.displayFulfillmentStatus !== 'UNFULFILLED') {
    return {
      state: 'not_cancellable',
      reason: 'fulfillment_in_progress',
      providerStatus,
    };
  }
  if (order.closed || order.displayFinancialStatus !== 'PENDING') {
    return {
      state: 'not_cancellable',
      reason: 'status_not_writable',
      providerStatus,
    };
  }
  return { state: 'cancellable', providerStatus };
}

@Injectable()
export class ShopifyOutcomeAdapter implements CommerceOutcomeAdapter {
  readonly platformType = 'shopify';
  readonly capabilities = new Set(COMMERCE_OUTCOME_ACTIONS);
  readonly requiresActiveConnection = true;
  // Only tag writes are tracked: a cancellation answers with a Shopify job
  // that automatic cancellation resolves itself, so a sync row for it would
  // stay pending.
  readonly tracksSynchronization = true;
  readonly trackedActions: ReadonlySet<CommerceOutcomeAction> = new Set(
    Object.keys(OUTCOME_TAGS) as TaggingAction[],
  );

  constructor(private readonly shopify: ShopifyApiService) {}

  async execute(
    request: CommerceOutcomeAdapterRequest,
  ): Promise<CommerceOutcomeOperationResult> {
    const { connection, externalOrderId, action } = request;
    if (!connection.platformStoreUrl || !connection.accessToken) {
      return {
        status: 'permanent_failure',
        errorCode: 'connection_incomplete',
      };
    }
    if (
      action === 'merchant_no_reply_cancellation' ||
      action === 'automatic_no_reply_cancellation'
    ) {
      const result = await this.shopify.cancelOrder(
        connection,
        externalOrderId,
        'CUSTOMER',
        action === 'automatic_no_reply_cancellation'
          ? request.cancellation
          : undefined,
      );
      return result.jobId
        ? {
            status: 'pending_provider_operation',
            providerOperationId: result.jobId,
          }
        : { status: 'accepted_without_reference' };
    }
    try {
      await this.shopify.addOrderTag(
        connection,
        externalOrderId,
        OUTCOME_TAGS[action],
      );
    } catch (error: unknown) {
      const result = classifyShopifyWriteError(error);
      if (!result) throw error;
      return result;
    }
    return { status: 'applied' };
  }

  async inspectForCancellation(
    request: CommerceOutcomeAdapterRequest,
  ): Promise<CommerceCancellationInspection> {
    const { connection, externalOrderId } = request;
    if (!connection.platformStoreUrl || !connection.accessToken) {
      return { state: 'permanent_failure', errorCode: 'connection_incomplete' };
    }
    return classifyShopifyCancellationState(
      await this.shopify.getOrderCancellationState(connection, externalOrderId),
    );
  }

  async resolveOperation(
    request: CommerceOutcomeAdapterRequest,
    providerOperationId: string,
  ): Promise<CommerceOperationResolution> {
    const { connection } = request;
    if (!connection.platformStoreUrl || !connection.accessToken) {
      return { state: 'failed', errorCode: 'connection_incomplete' };
    }
    const done = await this.shopify.isJobDone(connection, providerOperationId);
    return { state: done ? 'done' : 'running' };
  }
}
