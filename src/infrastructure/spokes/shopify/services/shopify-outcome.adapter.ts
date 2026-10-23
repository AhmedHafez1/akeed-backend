import { Injectable } from '@nestjs/common';
import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceCancellationInspection,
  type CommerceOperationResolution,
  type CommerceOutcomeAdapter,
  type CommerceOutcomeAdapterRequest,
  type CommerceOutcomeOperationResult,
} from '../../../../shared/commerce/commerce-outcome';
import { ShopifyApiService } from './shopify-api.service';
import type { ShopifyOrderCancellationState } from './shopify-api.service.helpers';

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
    const tags = {
      customer_confirmation: 'Akeed: Verified',
      customer_cancellation: 'Akeed: Canceled',
      merchant_cancellation_tagging: 'Akeed: Canceled',
      automatic_no_reply_tagging: 'Akeed: No Reply',
      automatic_no_whatsapp_tagging: 'Akeed: No WhatsApp',
    } as const;
    await this.shopify.addOrderTag(connection, externalOrderId, tags[action]);
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
