import { Injectable } from '@nestjs/common';
import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceOutcomeAdapter,
  type CommerceOutcomeAdapterRequest,
  type CommerceOutcomeOperationResult,
} from '../../../../shared/commerce/commerce-outcome';
import { ShopifyApiService } from './shopify-api.service';

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
    if (action === 'merchant_no_reply_cancellation') {
      const result = await this.shopify.cancelOrder(
        connection,
        externalOrderId,
        'CUSTOMER',
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
    } as const;
    await this.shopify.addOrderTag(connection, externalOrderId, tags[action]);
    return { status: 'applied' };
  }
}
