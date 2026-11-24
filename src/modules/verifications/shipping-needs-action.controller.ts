import {
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import { ShippingNotificationsService } from '../shipping-notifications/shipping-notifications.service';

/**
 * What an order's Shipped message asks of the merchant: a reschedule or
 * address request, or a message that could not reach the customer.
 */
@Controller('api/verifications/:id/shipping')
@UseGuards(DualAuthGuard)
export class ShippingNeedsActionController {
  constructor(private readonly shipping: ShippingNotificationsService) {}

  @Post('resolve')
  @HttpCode(200)
  async resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) verificationId: string,
  ): Promise<{ resolvedAt: string }> {
    return this.shipping.resolveNeedsAction(user, verificationId);
  }
}
