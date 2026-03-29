import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { drizzleProvider } from './database.provider';

import { OrdersRepository } from './repositories/orders.repository';
import { VerificationsRepository } from './repositories/verifications.repository';
import { IntegrationsRepository } from './repositories/integrations.repository';
import { OrganizationsRepository } from './repositories/organizations.repository';
import { MembershipsRepository } from './repositories/memberships.repository';
import { IntegrationMonthlyUsageRepository } from './repositories/integration-monthly-usage.repository';
import { WebhookEventsRepository } from './repositories/webhook-events.repository';
import { BillingFreePlanClaimsRepository } from './repositories/billing-free-plan-claims.repository';

@Module({
  imports: [ConfigModule],
  providers: [
    drizzleProvider,
    OrdersRepository,
    VerificationsRepository,
    IntegrationsRepository,
    OrganizationsRepository,
    MembershipsRepository,
    IntegrationMonthlyUsageRepository,
    WebhookEventsRepository,
    BillingFreePlanClaimsRepository,
  ],
  exports: [
    drizzleProvider,
    OrdersRepository,
    VerificationsRepository,
    IntegrationsRepository,
    OrganizationsRepository,
    MembershipsRepository,
    IntegrationMonthlyUsageRepository,
    WebhookEventsRepository,
    BillingFreePlanClaimsRepository,
  ],
})
export class DatabaseModule {}
