import { Module } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { CoreModule } from '../../../core/core.module';
import { DatabaseModule } from '../../database/database.module';
import { HttpModule } from '@nestjs/axios';
import { ShopifyApiService } from './services/shopify-api.service';

@Module({
  imports: [CoreModule, DatabaseModule, HttpModule],
  controllers: [ShopifyController],
  providers: [ShopifyApiService],
  exports: [ShopifyApiService],
})
export class ShopifyModule {}
