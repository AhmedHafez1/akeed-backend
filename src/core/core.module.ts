import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './modules/auth/auth.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { OrdersModule } from './modules/orders/orders.module';
import { VerificationsModule } from './modules/verifications/verifications.module';
import { WebhookQueueModule } from './modules/webhook-queue/webhook-queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: !process.env.NODE_ENV
        ? '.env'
        : `.env.${process.env.NODE_ENV}`,
    }),
    AuthModule,
    OnboardingModule,
    OrganizationsModule,
    OrdersModule,
    VerificationsModule,
    WebhookQueueModule,
  ],
  exports: [
    AuthModule,
    OnboardingModule,
    OrganizationsModule,
    OrdersModule,
    VerificationsModule,
    WebhookQueueModule,
  ],
})
export class CoreModule {}
