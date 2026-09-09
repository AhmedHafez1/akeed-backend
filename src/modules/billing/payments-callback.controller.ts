import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import { ConfigService } from '@nestjs/config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { PaymentCallbackRateLimitGuard } from '../../shared/guards/payment-callback-rate-limit.guard';
import {
  PaymobHmacGuard,
  type PaymobVerifiedRequest,
} from '../../infrastructure/spokes/paymob/paymob-hmac.guard';
import {
  mapPaymobCallback,
  UnsupportedPaymobEventError,
} from '../../infrastructure/spokes/paymob/paymob-status.mapper';
import { PaymentCallbackService } from './payment-callback.service';

/**
 * Paymob's processed callback.
 *
 * The path is fixed by configuration: `PAYMOB_CALLBACK_URL` is validated at
 * startup to end in exactly this route, so the URL Paymob is configured with
 * and the URL Nest serves cannot drift apart.
 *
 * `@SkipThrottle` removes the global 60-per-minute limit, which a settlement
 * burst or a redelivery wave would trip; the dedicated guard replaces it with
 * a ceiling generous enough for provider retries.
 */
@Controller('api/webhooks/payments')
@SkipThrottle()
export class PaymentsCallbackController {
  private readonly logger = new Logger(PaymentsCallbackController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly callbacks: PaymentCallbackService,
  ) {}

  /**
   * Answers 200 for anything applied, replayed or deliberately ignored, and
   * lets a transient database failure escape as a 5xx so Paymob retries.
   *
   * An authentic event that can never be applied -- an unsupported type, an
   * unmatched reference, data that does not match the stored purchase, or a
   * frozen account -- is 202. A 4xx there would have Paymob redelivering it
   * forever with no possible different result.
   */
  @Post('paymob')
  @UseGuards(PaymentCallbackRateLimitGuard, PaymobHmacGuard)
  @HttpCode(HttpStatus.OK)
  async paymob(
    @Req() request: PaymobVerifiedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ received: true; outcome: string }> {
    const verified = request.paymobEvent;
    if (!verified)
      throw new BadRequestException('Paymob callback was not verified');

    const billing = readStandaloneCreditBillingConfig(this.config);
    let event;
    try {
      event = mapPaymobCallback(
        { type: verified.type, obj: verified.obj },
        {
          source: 'callback',
          mode: billing.enabled ? billing.paymob.mode : 'test',
        },
      );
    } catch (error) {
      if (!(error instanceof UnsupportedPaymobEventError)) throw error;
      this.logger.warn(
        buildBackendLog(PaymentsCallbackController.name, {
          action: 'paymob-callback-unsupported',
          outcome: 'skipped',
          eventType: error.eventType,
          errorCode: 'unsupported_event_type',
        }),
      );
      response.status(HttpStatus.ACCEPTED);
      return { received: true, outcome: 'unsupported_event_type' };
    }

    const result = await this.callbacks.ingest(event);
    if (result.outcome === 'quarantined' || result.outcome === 'frozen')
      response.status(HttpStatus.ACCEPTED);
    return { received: true, outcome: result.resultCode };
  }
}
