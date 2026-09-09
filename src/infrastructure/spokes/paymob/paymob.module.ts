import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PaymobHmacGuard } from './paymob-hmac.guard';
import { PaymobPaymentsAdapter } from './paymob-payments.adapter';

/**
 * The Paymob spoke: provider payloads, credentials, URLs and status meanings,
 * and nothing else.
 *
 * It has no database dependency and imports nothing from `modules/billing`.
 * Everything it exports is expressed in the provider-neutral vocabulary of
 * `shared/ports/payments.port`, which is what lets a second processor be added
 * later without reopening the billing module.
 */
@Module({
  imports: [ConfigModule, HttpModule],
  providers: [PaymobPaymentsAdapter, PaymobHmacGuard],
  exports: [PaymobPaymentsAdapter, PaymobHmacGuard],
})
export class PaymobModule {}
