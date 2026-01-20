import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../infrastructure/database/database.module';
import { VerificationHubService } from './services/verification-hub.service';
import { MetaModule } from 'src/infrastructure/spokes/meta/meta.module';
import { ShopifyModule } from 'src/infrastructure/spokes/shopify/shopify.module';

@Module({
  imports: [
    DatabaseModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: !process.env.NODE_ENV
        ? '.env'
        : `.env.${process.env.NODE_ENV}`,
    }),
    forwardRef(() => MetaModule),
    forwardRef(() => ShopifyModule),
  ],
  providers: [VerificationHubService],
  exports: [VerificationHubService],
})
export class CoreModule {}
