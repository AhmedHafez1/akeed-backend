import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../../../infrastructure/database/database.module';
import { VerificationsController } from '../../controllers/verifications.controller';
import { VerificationsService } from '../../services/verifications.service';
import { VerificationHubService } from '../../services/verification-hub.service';
import { BillingEntitlementService } from '../../services/billing-entitlement.service';
import { OrderEligibilityService } from '../../services/order-eligibility.service';
import { ShopifyOrderEligibilityStrategy } from '../../services/order-eligibility/strategies/shopify-order-eligibility.strategy';
import { AuthModule } from '../auth/auth.module';
import { MetaModule } from '../../../infrastructure/spokes/meta/meta.module';
import { ShopifyModule } from '../../../infrastructure/spokes/shopify/shopify.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    forwardRef(() => MetaModule),
    forwardRef(() => ShopifyModule),
  ],
  controllers: [VerificationsController],
  providers: [
    VerificationsService,
    VerificationHubService,
    BillingEntitlementService,
    OrderEligibilityService,
    ShopifyOrderEligibilityStrategy,
  ],
  exports: [VerificationsService, VerificationHubService],
})
export class VerificationsModule {}
