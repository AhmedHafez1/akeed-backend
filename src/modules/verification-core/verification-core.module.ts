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
import { ShopifyOrderEligibilityStrategy } from './strategies/shopify-order-eligibility.strategy';

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
      imports: [DatabaseModule, ...config.imports],
      providers: [
        VerificationHubService,
        BillingEntitlementService,
        OrderEligibilityService,
        VerificationSendService,
        ShopifyOrderEligibilityStrategy,
        ...config.ports,
      ],
      exports: [
        VerificationHubService,
        BillingEntitlementService,
        OrderEligibilityService,
        VerificationSendService,
        ...config.ports.map(extractProviderToken),
      ],
    };
  }
}
