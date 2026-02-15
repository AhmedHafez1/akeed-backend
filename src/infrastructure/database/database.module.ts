import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { drizzleProvider } from './database.provider';

import { OrdersRepository } from './repositories/orders.repository';
import { VerificationsRepository } from './repositories/verifications.repository';
import { IntegrationsRepository } from './repositories/integrations.repository';
import { OrganizationsRepository } from './repositories/organizations.repository';
import { MembershipsRepository } from './repositories/memberships.repository';
import { ShopifyWebhookEventsRepository } from './repositories/shopify-webhook-events.repository';
import { IntegrationMonthlyUsageRepository } from './repositories/integration-monthly-usage.repository';

@Module({
  imports: [ConfigModule],
  providers: [
    drizzleProvider,
    OrdersRepository,
    VerificationsRepository,
    IntegrationsRepository,
    OrganizationsRepository,
    MembershipsRepository,
    ShopifyWebhookEventsRepository,
    IntegrationMonthlyUsageRepository,
  ],
  exports: [
    drizzleProvider,
    OrdersRepository,
    VerificationsRepository,
    IntegrationsRepository,
    OrganizationsRepository,
    MembershipsRepository,
    ShopifyWebhookEventsRepository,
    IntegrationMonthlyUsageRepository,
  ],
})
export class DatabaseModule {}
