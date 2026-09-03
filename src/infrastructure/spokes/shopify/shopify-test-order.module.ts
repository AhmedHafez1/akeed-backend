import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database';
import { ShopifyCommerceModule } from './shopify-commerce.module';
import { ShopifyTestOrderService } from './services/shopify-test-order.service';

@Module({
  imports: [DatabaseModule, ShopifyCommerceModule],
  providers: [ShopifyTestOrderService],
  exports: [ShopifyTestOrderService],
})
export class ShopifyTestOrderModule {}
