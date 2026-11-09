import { SENDER_RESOLVER_PORT } from './shared/ports/sender-resolver.port';
import { SenderResolverService } from './modules/whatsapp-sender/sender-resolver.service';
import { ShopifyOrderEligibilityStrategy } from './infrastructure/spokes/shopify/services/shopify-order-eligibility.strategy';
import { StandaloneOrderEligibilityStrategy } from './infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { EasyOrdersOrderEligibilityStrategy } from './infrastructure/spokes/easyorders/easyorders-order-eligibility.strategy';
import { WooCommerceOrderEligibilityStrategy } from './infrastructure/spokes/woocommerce/woocommerce-order-eligibility.strategy';
import { ORDER_ELIGIBILITY_STRATEGIES } from './modules/verification-core/strategies/order-eligibility.strategy';
import { CURRENT_ORDER_SOURCES } from './shared/ports/current-order-source.port';
import { ShopifyCurrentOrderSource } from './infrastructure/spokes/shopify/services/shopify-current-order.source';
import { StandaloneCurrentOrderSource } from './infrastructure/spokes/standalone/services/standalone-current-order.source';
import { EasyOrdersCurrentOrderSource } from './infrastructure/spokes/easyorders/easyorders-current-order.source';
import { WooCommerceCurrentOrderSource } from './infrastructure/spokes/woocommerce/woocommerce-current-order.source';
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
import { MerchantBrandingModule } from './modules/merchant-branding/merchant-branding.module';
import { ReviewPromptModule } from './modules/review-prompt/review-prompt.module';
import { MarketingEventsModule } from './modules/marketing-events/marketing-events.module';
import { TipsModule } from './modules/tips/tips.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { OrdersModule } from './modules/orders/orders.module';
import { OrderImportsModule } from './modules/order-imports/order-imports.module';
import { IntegrationKeysModule } from './modules/integration-keys/integration-keys.module';
import { OrderApiModule } from './modules/order-api/order-api.module';
import { VerificationsModule } from './modules/verifications/verifications.module';
import { WebhookQueueModule } from './modules/webhook-queue/webhook-queue.module';
import { VerificationCoreModule } from './modules/verification-core/verification-core.module';
import { VerificationAutomationModule } from './modules/verification-automation/verification-automation.module';
import { CapacityRecoveryModule } from './modules/capacity-recovery/capacity-recovery.module';
import { CreditModelNoticeModule } from './modules/credit-model-notice/credit-model-notice.module';
import { AutoCancellationModule } from './modules/auto-cancellation/auto-cancellation.module';
import { ChangeRequestsModule } from './modules/change-requests/change-requests.module';
import { WhatsappSenderModule } from './modules/whatsapp-sender/whatsapp-sender.module';
import { EMAIL_PORT } from './shared/ports/email.port';
import { ResendEmailAdapter } from './infrastructure/spokes/resend/resend-email.adapter';
import { MESSAGING_PORT } from './shared/ports/messaging.port';
import { TEMPLATE_REGISTRY_PORT } from './shared/ports/template-registry.port';
import { TemplateRegistryService } from './modules/template-registry/template-registry.service';
import { TEMPLATE_CATALOG_PORT } from './shared/ports/template-catalog.port';
import { MetaTemplateCatalogAdapter } from './infrastructure/spokes/meta/meta-template-catalog.adapter';
import { MetaModule } from './infrastructure/spokes/meta/meta.module';
import { ShopifyModule } from './infrastructure/spokes/shopify/shopify.module';
import { WhatsAppService } from './infrastructure/spokes/meta/whatsapp.service';
import { DatabaseModule } from './infrastructure/database';
import { AdminModule } from './modules/admin/admin.module';
import { BillingModule } from './modules/billing/billing.module';
import { PaymobModule } from './infrastructure/spokes/paymob/paymob.module';
import { EasyOrdersModule } from './infrastructure/spokes/easyorders/easyorders.module';
import { EasyOrdersIngestionModule } from './infrastructure/spokes/easyorders/easyorders-ingestion.module';
import { WooCommerceModule } from './infrastructure/spokes/woocommerce/woocommerce.module';
import { WooCommerceIngestionModule } from './infrastructure/spokes/woocommerce/woocommerce-ingestion.module';
import { PaymobPaymentsAdapter } from './infrastructure/spokes/paymob/paymob-payments.adapter';
import { PAYMENTS_PORT } from './shared/ports/payments.port';
import { CommerceOutcomeModule } from './modules/commerce-outcomes/commerce-outcome.module';
import { CommerceOutcomeSyncModule } from './modules/commerce-outcomes/commerce-outcome-sync.module';
import { DEFAULT_QUEUE_JOB_OPTIONS } from './shared/queue/job-options';
import { validateEnv } from './shared/config/env-validation';

// The payment provider reaches billing as a port binding, so nothing in the
// billing module names Paymob and a second processor is a new spoke plus one
// line here.
const billingModule = BillingModule.register({
  imports: [PaymobModule],
  ports: [{ provide: PAYMENTS_PORT, useExisting: PaymobPaymentsAdapter }],
});

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
      // Each store spoke's module provides its own eligibility strategy.
      // Standalone has no module, so its strategy is provided here.
      imports: [
        MetaModule,
        WhatsappSenderModule,
        ShopifyModule,
        EasyOrdersIngestionModule,
        WooCommerceIngestionModule,
      ],
      ports: [
        StandaloneOrderEligibilityStrategy,
        {
          provide: ORDER_ELIGIBILITY_STRATEGIES,
          inject: [
            ShopifyOrderEligibilityStrategy,
            StandaloneOrderEligibilityStrategy,
            EasyOrdersOrderEligibilityStrategy,
            WooCommerceOrderEligibilityStrategy,
          ],
          useFactory: (
            shopify: ShopifyOrderEligibilityStrategy,
            standalone: StandaloneOrderEligibilityStrategy,
            easyOrders: EasyOrdersOrderEligibilityStrategy,
            wooCommerce: WooCommerceOrderEligibilityStrategy,
          ) => [shopify, standalone, easyOrders, wooCommerce],
        },
        StandaloneCurrentOrderSource,
        {
          provide: CURRENT_ORDER_SOURCES,
          inject: [
            ShopifyCurrentOrderSource,
            StandaloneCurrentOrderSource,
            EasyOrdersCurrentOrderSource,
            WooCommerceCurrentOrderSource,
          ],
          useFactory: (
            shopify: ShopifyCurrentOrderSource,
            standalone: StandaloneCurrentOrderSource,
            easyOrders: EasyOrdersCurrentOrderSource,
            wooCommerce: WooCommerceCurrentOrderSource,
          ) => [shopify, standalone, easyOrders, wooCommerce],
        },
        { provide: MESSAGING_PORT, useExisting: WhatsAppService },
        { provide: SENDER_RESOLVER_PORT, useExisting: SenderResolverService },
        ResendEmailAdapter,
        { provide: EMAIL_PORT, useExisting: ResendEmailAdapter },
        TemplateRegistryService,
        {
          provide: TEMPLATE_REGISTRY_PORT,
          useExisting: TemplateRegistryService,
        },
        {
          provide: TEMPLATE_CATALOG_PORT,
          useExisting: MetaTemplateCatalogAdapter,
        },
      ],
    }),
    AuthModule,
    OnboardingModule,
    MerchantBrandingModule,
    ReviewPromptModule,
    MarketingEventsModule,
    TipsModule,
    OrganizationsModule,
    OrdersModule,
    OrderImportsModule,
    IntegrationKeysModule,
    EasyOrdersModule,
    WooCommerceModule,
    OrderApiModule,
    VerificationsModule,
    WebhookQueueModule,
    VerificationAutomationModule,
    CapacityRecoveryModule,
    CreditModelNoticeModule,
    AutoCancellationModule,
    ChangeRequestsModule,
    WhatsappSenderModule,
    DatabaseModule,
    // Staff billing operations drive the same payment services, so they
    // receive this one billing module instance instead of registering another.
    AdminModule.register({ imports: [billingModule] }),
    CommerceOutcomeModule,
    CommerceOutcomeSyncModule,
    billingModule,
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
