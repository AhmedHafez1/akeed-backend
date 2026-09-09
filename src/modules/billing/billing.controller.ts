import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
  UsePipes,
  type ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import { BillingService } from './billing.service';
import { BILLING_ERROR_CODES } from './billing.types';
import {
  CreatePurchaseDto,
  LedgerQueryDto,
  PageQueryDto,
  PurchaseRefParamDto,
} from './dto/billing.dto';

/**
 * `forbidNonWhitelisted` is the point of declaring a pipe here.
 *
 * The global pipe strips unknown properties silently, so a request carrying its
 * own `unitPriceMinor` or `status` would be accepted and quietly ignored.
 * Money endpoints should say no instead.
 */
const billingValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory(errors: ValidationError[]) {
    return new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Billing request validation failed.',
      code: BILLING_ERROR_CODES.validationFailed,
      fieldErrors: Object.fromEntries(
        errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ??
            `${error.property} is invalid.`,
        ]),
      ),
    });
  },
});

/**
 * Merchant billing.
 *
 * Every response is `private, no-store`: a balance, a ledger page and a
 * purchase state are all per-member and change under the reader, and a shared
 * or disk cache would serve one tenant's money to the next request.
 */
@Controller('api/billing')
@UseGuards(DualAuthGuard)
@UsePipes(billingValidationPipe)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('credits')
  @Header('Cache-Control', 'private, no-store')
  readCredits(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.readCredits(user);
  }

  @Get('credits/ledger')
  @Header('Cache-Control', 'private, no-store')
  listLedger(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: LedgerQueryDto,
  ) {
    return this.billing.listLedger(user, query);
  }

  @Get('purchases')
  @Header('Cache-Control', 'private, no-store')
  listPurchases(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PageQueryDto,
  ) {
    return this.billing.listPurchases(user, query);
  }

  @Get('purchases/:purchaseRef')
  @Header('Cache-Control', 'private, no-store')
  readPurchase(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: PurchaseRefParamDto,
  ) {
    return this.billing.readPurchase(user, params.purchaseRef);
  }

  /**
   * Only the quantity is read from the body. The organization, actor, price,
   * currency and provider are all derived server-side.
   */
  @Post('purchases')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createPurchase(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() payload: CreatePurchaseDto,
  ) {
    return this.billing.createPurchase(user, idempotencyKey, payload.quantity);
  }
}
