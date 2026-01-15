import { Module } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [ShopifyController],
})
export class ShopifyModule {}
