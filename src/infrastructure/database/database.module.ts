import { PeriodicPlanAccounting } from './repositories/periodic-plan-accounting';
import { PrepaidCreditAccounting } from './repositories/prepaid-credit-accounting';
import { UsageAccountingRouter } from './repositories/usage-accounting.router';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { drizzleProvider } from './database.provider';
import { CreditAccountingRepository } from './repositories/credit-accounting.repository';
import { PaymentPurchasesRepository } from './repositories/payment-purchases.repository';

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
import { VerificationMessageDispatchesRepository } from './repositories/verification-message-dispatches.repository';

@Module({
  imports: [ConfigModule],
  providers: [
    CreditAccountingRepository,
    PeriodicPlanAccounting,
    PrepaidCreditAccounting,
    UsageAccountingRouter,
    PaymentPurchasesRepository,
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
    VerificationMessageDispatchesRepository,
  ],
  exports: [
    CreditAccountingRepository,
    PeriodicPlanAccounting,
    PrepaidCreditAccounting,
    UsageAccountingRouter,
    PaymentPurchasesRepository,
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
    VerificationMessageDispatchesRepository,
  ],
})
export class DatabaseModule {}
