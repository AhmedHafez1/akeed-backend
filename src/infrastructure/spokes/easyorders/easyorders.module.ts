import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../../../modules/auth/auth.module';
import { EasyOrdersApiClient, EASYORDERS_HTTP } from './easyorders-api.client';
import { EasyOrdersAuthService } from './easyorders-auth.service';
import { EasyOrdersConnectionController } from './easyorders-connection.controller';
import { EasyOrdersInstallCallbackController } from './easyorders-install-callback.controller';

/**
 * The EasyOrders spoke. US-06-02 covers the authorized connection only: no
 * webhook route, normalizer, eligibility strategy or outcome adapter is
 * registered yet, so no EasyOrders order can enter verification.
 */
@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule],
  controllers: [
    EasyOrdersConnectionController,
    EasyOrdersInstallCallbackController,
  ],
  providers: [
    EasyOrdersAuthService,
    EasyOrdersApiClient,
    {
      provide: EASYORDERS_HTTP,
      useValue: (...args: Parameters<typeof fetch>) => fetch(...args),
    },
  ],
})
export class EasyOrdersModule {}
