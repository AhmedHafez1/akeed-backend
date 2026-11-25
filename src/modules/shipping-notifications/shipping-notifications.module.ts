import {
  DynamicModule,
  ForwardReference,
  Module,
  Provider,
  Type,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { VerificationAutomationQueueModule } from '../verification-automation/verification-automation-queue.module';
import { ShippingNotificationsService } from './shipping-notifications.service';

/**
 * The platform-neutral shipping core. The app binds `SHIPPING_EVENT_SOURCES`
 * through `sources`; each store spoke's module provides its own source.
 * Global, so webhook intake and settings can ask for it without importing
 * the spokes.
 */
@Module({})
export class ShippingNotificationsModule {
  static register(config: {
    imports: Array<Type<any> | DynamicModule | ForwardReference>;
    sources: Provider;
  }): DynamicModule {
    return {
      module: ShippingNotificationsModule,
      global: true,
      imports: [
        ConfigModule,
        DatabaseModule,
        VerificationAutomationQueueModule,
        ...config.imports,
      ],
      providers: [ShippingNotificationsService, config.sources],
      exports: [ShippingNotificationsService],
    };
  }
}
