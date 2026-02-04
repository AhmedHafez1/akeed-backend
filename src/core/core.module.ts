import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../infrastructure/database/database.module';
import { VerificationHubService } from './services/verification-hub.service';
import { MetaModule } from 'src/infrastructure/spokes/meta/meta.module';
import { ShopifyModule } from 'src/infrastructure/spokes/shopify/shopify.module';
import { DualAuthGuard } from './guards/dual-auth.guard';
import { TokenValidatorService } from './services/token-validator.service';
import { OrganizationsController } from './controllers/organizations.controller';
import { OrganizationsService } from './services/organizations.service';
import { VerificationsController } from './controllers/verifications.controller';
import { OrdersController } from './controllers/orders.controller';
import { VerificationsService } from './services/verifications.service';
import { OrdersService } from './services/orders.service';

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
  controllers: [
    OrganizationsController,
    VerificationsController,
    OrdersController,
  ],
  providers: [
    VerificationHubService,
    DualAuthGuard,
    TokenValidatorService,
    OrganizationsService,
    VerificationsService,
    OrdersService,
  ],
  exports: [VerificationHubService, DualAuthGuard],
})
export class CoreModule {}
