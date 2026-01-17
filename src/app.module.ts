import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ShopifyModule } from './infrastructure/spokes/shopify/shopify.module';
import { MetaModule } from './infrastructure/spokes/meta/meta.module';

@Module({
  imports: [CoreModule, ShopifyModule, MetaModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
