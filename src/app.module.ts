import { ShopifyOrderEligibilityStrategy } from './infrastructure/spokes/shopify/services/shopify-order-eligibility.strategy';
import { StandaloneOrderEligibilityStrategy } from './infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { ORDER_ELIGIBILITY_STRATEGIES } from './modules/verification-core/strategies/order-eligibility.strategy';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SecurityMiddleware } from './shared/middleware/security.middleware';
import { AuthModule } from './modules/auth/auth.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { OrdersModule } from './modules/orders/orders.module';
import { VerificationsModule } from './modules/verifications/verifications.module';
import { WebhookQueueModule } from './modules/webhook-queue/webhook-queue.module';
import { VerificationCoreModule } from './modules/verification-core/verification-core.module';
import { VerificationAutomationModule } from './modules/verification-automation/verification-automation.module';
import { MESSAGING_PORT } from './shared/ports/messaging.port';
import { MetaModule } from './infrastructure/spokes/meta/meta.module';
import { ShopifyModule } from './infrastructure/spokes/shopify/shopify.module';
import { WhatsAppService } from './infrastructure/spokes/meta/whatsapp.service';
import { DatabaseModule } from './infrastructure/database';
import { AdminModule } from './modules/admin/admin.module';
import { BillingModule } from './modules/billing/billing.module';
import { PaymobModule } from './infrastructure/spokes/paymob/paymob.module';
import { PaymobPaymentsAdapter } from './infrastructure/spokes/paymob/paymob-payments.adapter';
import { PAYMENTS_PORT } from './shared/ports/payments.port';
import { CommerceOutcomeModule } from './modules/commerce-outcomes/commerce-outcome.module';
import { DEFAULT_QUEUE_JOB_OPTIONS } from './shared/queue/job-options';
import { validateEnv } from './shared/config/env-validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: !process.env.NODE_ENV
        ? '.env'
        : `.env.${process.env.NODE_ENV}`,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: 60_000,
          limit: 60,
        },
      ],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('REDIS_URL', 'redis://localhost:6379'),
        },
        defaultJobOptions: DEFAULT_QUEUE_JOB_OPTIONS,
      }),
    }),
    VerificationCoreModule.register({
      imports: [MetaModule, ShopifyModule],
      ports: [
        StandaloneOrderEligibilityStrategy,
        {
          provide: ORDER_ELIGIBILITY_STRATEGIES,
          inject: [
            ShopifyOrderEligibilityStrategy,
            StandaloneOrderEligibilityStrategy,
          ],
          useFactory: (
            shopify: ShopifyOrderEligibilityStrategy,
            standalone: StandaloneOrderEligibilityStrategy,
          ) => [shopify, standalone],
        },
        { provide: MESSAGING_PORT, useExisting: WhatsAppService },
      ],
    }),
    AuthModule,
    OnboardingModule,
    OrganizationsModule,
    OrdersModule,
    VerificationsModule,
    WebhookQueueModule,
    VerificationAutomationModule,
    DatabaseModule,
    AdminModule,
    CommerceOutcomeModule,
    // The payment provider reaches billing as a port binding, so nothing in
    // the billing module names Paymob and a second processor is a new spoke
    // plus one line here.
    BillingModule.register({
      imports: [PaymobModule],
      ports: [{ provide: PAYMENTS_PORT, useExisting: PaymobPaymentsAdapter }],
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    SecurityMiddleware,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SecurityMiddleware).forRoutes('*');
  }
}
