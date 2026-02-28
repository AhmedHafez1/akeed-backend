import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { shopifyWebhookEvents } from '../schema';

interface ShopifyWebhookEventInput {
  webhookId: string;
  topic?: string;
  shopDomain?: string;
  orgId?: string | null;
  integrationId?: string | null;
}

@Injectable()
export class ShopifyWebhookEventsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async recordIfNew(event: ShopifyWebhookEventInput): Promise<boolean> {
    const [result] = await this.db
      .insert(shopifyWebhookEvents)
      .values({
        webhookId: event.webhookId,
        topic: event.topic,
        shopDomain: event.shopDomain,
        orgId: event.orgId ?? null,
        integrationId: event.integrationId ?? null,
      })
      .onConflictDoNothing({ target: shopifyWebhookEvents.webhookId })
      .returning({ id: shopifyWebhookEvents.id });

    return Boolean(result);
  }

  async deleteByOrgId(orgId: string): Promise<number> {
    const results = await this.db
      .delete(shopifyWebhookEvents)
      .where(eq(shopifyWebhookEvents.orgId, orgId))
      .returning({ id: shopifyWebhookEvents.id });

    return results.length;
  }
}
