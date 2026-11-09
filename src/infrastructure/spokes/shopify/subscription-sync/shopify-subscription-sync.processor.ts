import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SHOPIFY_SUBSCRIPTION_SYNC_ENABLED_KEY,
  SHOPIFY_SUBSCRIPTION_SYNC_QUEUE,
  isShopifySubscriptionSyncEnabled,
} from './shopify-subscription-sync.constants';
import { ShopifySubscriptionSyncService } from './shopify-subscription-sync.service';

@Processor(SHOPIFY_SUBSCRIPTION_SYNC_QUEUE, { concurrency: 1 })
@Injectable()
export class ShopifySubscriptionSyncProcessor extends WorkerHost {
  constructor(
    private readonly sync: ShopifySubscriptionSyncService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(): Promise<void> {
    if (
      !isShopifySubscriptionSyncEnabled(
        this.config.get<string>(SHOPIFY_SUBSCRIPTION_SYNC_ENABLED_KEY),
      )
    )
      return;
    await this.sync.reconcileAll();
  }
}
