import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { SHOPIFY_OFFLINE_CREDENTIALS_QUEUE } from './shopify-offline-credentials.constants';
import { ShopifyOfflineCredentialsService } from './shopify-offline-credentials.service';

/** One run at a time, so two workers never take the same batch. */
@Processor(SHOPIFY_OFFLINE_CREDENTIALS_QUEUE, { concurrency: 1 })
@Injectable()
export class ShopifyOfflineCredentialsProcessor extends WorkerHost {
  constructor(private readonly service: ShopifyOfflineCredentialsService) {
    super();
  }

  async process(): Promise<void> {
    await this.service.runOnce();
  }
}
