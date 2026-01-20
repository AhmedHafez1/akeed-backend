import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CoreModule } from './core/core.module';
import { MetaModule } from './infrastructure/spokes/meta/meta.module';
import { ShopifyModule } from './infrastructure/spokes/shopify/shopify.module';

@Module({
  imports: [CoreModule, MetaModule, ShopifyModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
