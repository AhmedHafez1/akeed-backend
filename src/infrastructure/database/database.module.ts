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
import { AdminStoreLifecyclesRepository } from './repositories/admin-store-lifecycles.repository';
import { AdminAccessAuditRepository } from './repositories/admin-access-audit.repository';
import { StandaloneOrganizationProvisioningRepository } from './repositories/standalone-organization-provisioning.repository';
import { ManualOrderIngestionRepository } from './repositories/manual-order-ingestion.repository';

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
    AdminStoreLifecyclesRepository,
    AdminAccessAuditRepository,
    StandaloneOrganizationProvisioningRepository,
    ManualOrderIngestionRepository,
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
    AdminStoreLifecyclesRepository,
    AdminAccessAuditRepository,
    StandaloneOrganizationProvisioningRepository,
    ManualOrderIngestionRepository,
  ],
})
export class DatabaseModule {}
