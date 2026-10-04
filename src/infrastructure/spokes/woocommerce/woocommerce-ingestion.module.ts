import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PhoneService } from '../../../shared/services/phone.service';
import { WooCommerceOrderNormalizer } from './woocommerce-order.normalizer';

/**
 * What the workers need from the WooCommerce spoke: the order normalizer
 * (US-07-03). Kept apart from `WooCommerceModule`, which imports the webhook
 * queue for its delivery route, so the queue can import this without a cycle.
 */
@Module({
  imports: [DatabaseModule],
  providers: [WooCommerceOrderNormalizer, PhoneService],
  exports: [WooCommerceOrderNormalizer],
})
export class WooCommerceIngestionModule {}
