import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SecurityMiddleware } from './core/middleware/security.middleware';
import { AuthModule } from './core/modules/auth/auth.module';
import { OnboardingModule } from './core/modules/onboarding/onboarding.module';
import { OrganizationsModule } from './core/modules/organizations/organizations.module';
import { OrdersModule } from './core/modules/orders/orders.module';
import { VerificationsModule } from './core/modules/verifications/verifications.module';
import { WebhookQueueModule } from './core/modules/webhook-queue/webhook-queue.module';
import { VerificationCoreModule } from './core/modules/verification-core/verification-core.module';
import { MESSAGING_PORT } from './core/ports/messaging.port';
import { ORDER_TAGGING_PORT } from './core/ports/order-tagging.port';
import { MetaModule } from './infrastructure/spokes/meta/meta.module';
import { ShopifyModule } from './infrastructure/spokes/shopify/shopify.module';
import { WhatsAppService } from './infrastructure/spokes/meta/whatsapp.service';
import { ShopifyApiService } from './infrastructure/spokes/shopify/services/shopify-api.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: !process.env.NODE_ENV
        ? '.env'
        : `.env.${process.env.NODE_ENV}`,
    }),
    VerificationCoreModule.register({
      imports: [MetaModule, ShopifyModule],
      ports: [
        { provide: MESSAGING_PORT, useExisting: WhatsAppService },
        { provide: ORDER_TAGGING_PORT, useExisting: ShopifyApiService },
      ],
    }),
    AuthModule,
    OnboardingModule,
    OrganizationsModule,
    OrdersModule,
    VerificationsModule,
    WebhookQueueModule,
  ],
  controllers: [AppController],
  providers: [AppService, SecurityMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SecurityMiddleware).forRoutes('*');
  }
}
