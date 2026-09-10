import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
} from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database';
import { AuthModule } from '../auth/auth.module';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminController } from './admin.controller';
import { AdminFunnelService } from './admin-funnel.service';
import { AdminHealthRuleService } from './admin-health-rule.service';
import { AdminQueryRepository } from './admin-query.repository';
import { AdminStoresService } from './admin-stores.service';
import { StandaloneBillingController } from './standalone-billing.controller';
import { StandaloneBillingLoggingInterceptor } from './standalone-billing-logging.interceptor';
import { StandaloneBillingOperationsRepository } from './standalone-billing-operations.repository';
import { StandaloneBillingOperationsService } from './standalone-billing-operations.service';
import { StandaloneBillingOperatorGuard } from './standalone-billing-operator.guard';
import { StandaloneBillingRepository } from './standalone-billing.repository';
import { StandaloneBillingService } from './standalone-billing.service';
import { MessageDispatchResolutionService } from './message-dispatch-resolution.service';
import { WebhookQueueModule } from '../webhook-queue/webhook-queue.module';
import { BillingReconciliationQueueModule } from './billing-reconciliation-queue.module';
import { BillingObservabilityRepository } from './billing-observability.repository';
import { BillingObservabilityService } from './billing-observability.service';
import { BillingReconciliationProducer } from './billing-reconciliation.producer';
import { BillingReconciliationProcessor } from './billing-reconciliation.processor';

export interface AdminModuleOptions {
  /**
   * The registered billing module whose payment services staff operations
   * drive. It is passed in rather than imported here so the application keeps
   * exactly one instance of it, and so this module names no payment provider.
   */
  imports?: ModuleMetadata['imports'];
}

@Module({})
export class AdminModule {
  static register(options: AdminModuleOptions = {}): DynamicModule {
    return {
      module: AdminModule,
      imports: [
        AuthModule,
        DatabaseModule,
        WebhookQueueModule,
        BillingReconciliationQueueModule,
        ...(options.imports ?? []),
      ],
      controllers: [AdminController, StandaloneBillingController],
      providers: [
        AdminAccessGuard,
        AdminQueryRepository,
        AdminStoresService,
        AdminFunnelService,
        AdminHealthRuleService,
        StandaloneBillingRepository,
        StandaloneBillingService,
        StandaloneBillingOperatorGuard,
        StandaloneBillingLoggingInterceptor,
        StandaloneBillingOperationsRepository,
        StandaloneBillingOperationsService,
        MessageDispatchResolutionService,
        BillingObservabilityRepository,
        BillingObservabilityService,
        BillingReconciliationProducer,
        BillingReconciliationProcessor,
      ],
    };
  }
}
