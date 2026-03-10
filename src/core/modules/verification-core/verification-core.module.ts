import {
  DynamicModule,
  Module,
  Provider,
  Type,
  ForwardReference,
} from '@nestjs/common';
import { DatabaseModule } from '../../../infrastructure/database/database.module';
import { VerificationHubService } from '../../services/verification-hub.service';
import { BillingEntitlementService } from '../../services/billing-entitlement.service';
import { OrderEligibilityService } from '../../services/order-eligibility.service';
import { ShopifyOrderEligibilityStrategy } from '../../services/order-eligibility/strategies/shopify-order-eligibility.strategy';

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
        ShopifyOrderEligibilityStrategy,
        ...config.ports,
      ],
      exports: [
        VerificationHubService,
        BillingEntitlementService,
        OrderEligibilityService,
      ],
    };
  }
}
