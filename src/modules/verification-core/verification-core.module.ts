import {
  DynamicModule,
  Module,
  Provider,
  Type,
  ForwardReference,
  InjectionToken,
} from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { VerificationHubService } from './verification-hub.service';
import { BillingEntitlementService } from './billing-entitlement.service';
import { OrderEligibilityService } from './order-eligibility.service';
import { VerificationSendService } from './verification-send.service';
import { CreditEligibilityService } from './credit-eligibility.service';
import { VerificationAutomationQueueModule } from '../verification-automation/verification-automation-queue.module';
import { MessageImprovementSwitches } from '../../shared/config/message-improvement-switches';
import { MessageTextsService } from '../message-texts/message-texts.service';
import { TemplateMessageService } from '../template-registry/template-message.service';
import { UsageAlertService } from './usage-alert.service';
import { CapacityRecoveryQueueModule } from '../capacity-recovery/capacity-recovery-queue.module';

function extractProviderToken(provider: Provider): InjectionToken {
  if (typeof provider === 'function') {
    return provider;
  }
  return (provider as { provide: InjectionToken }).provide;
}

@Module({})
export class VerificationCoreModule {
  static register(config: {
    imports: Array<Type<any> | DynamicModule | ForwardReference>;
    ports: Provider[];
  }): DynamicModule {
    return {
      module: VerificationCoreModule,
      global: true,
      imports: [
        DatabaseModule,
        VerificationAutomationQueueModule,
        CapacityRecoveryQueueModule,
        ...config.imports,
      ],
      providers: [
        VerificationHubService,
        BillingEntitlementService,
        OrderEligibilityService,
        VerificationSendService,
        CreditEligibilityService,
        MessageImprovementSwitches,
        MessageTextsService,
        TemplateMessageService,
        UsageAlertService,
        ...config.ports,
      ],
      exports: [
        VerificationHubService,
        BillingEntitlementService,
        OrderEligibilityService,
        VerificationSendService,
        CreditEligibilityService,
        MessageImprovementSwitches,
        MessageTextsService,
        TemplateMessageService,
        UsageAlertService,
        // Global through this module, so billing, onboarding and the Shopify
        // spoke can ask for recovery without importing the queue themselves.
        CapacityRecoveryQueueModule,
        ...config.ports.map(extractProviderToken),
      ],
    };
  }
}
