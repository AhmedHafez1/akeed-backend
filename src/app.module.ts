import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ShopifyModule } from './infrastructure/spokes/shopify/shopify.module';

@Module({
  imports: [CoreModule, ShopifyModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
