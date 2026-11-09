import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import type { ReconfirmationView } from '../verification-core/change-request-reconfirmation.service';
import {
  ChangeRequestMerchantService,
  type ChangeRequestResolutionResponse,
  type ChangeRequestView,
} from './change-request-merchant.service';
import {
  ChangeRequestActionDto,
  ChangeRequestResendDto,
} from './dto/change-request-action.dto';

/** A customer's change request on one order, for the merchant. */
@Controller('api/verifications/:id/change-request')
@UseGuards(DualAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ChangeRequestsController {
  constructor(private readonly merchant: ChangeRequestMerchantService) {}

  @Get()
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) verificationId: string,
  ): Promise<{ change_request: ChangeRequestView | null }> {
    return this.merchant.get(user, verificationId);
  }

  @Post('confirm')
  @HttpCode(200)
  async confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) verificationId: string,
    @Body() body: ChangeRequestActionDto,
  ): Promise<ChangeRequestResolutionResponse> {
    return this.merchant.confirm(user, verificationId, body.changeRequestId);
  }

  @Post('cancel')
  @HttpCode(200)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) verificationId: string,
    @Body() body: ChangeRequestActionDto,
  ): Promise<ChangeRequestResolutionResponse> {
    return this.merchant.cancel(user, verificationId, body.changeRequestId);
  }

  @Post('resend')
  @HttpCode(202)
  async resend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) verificationId: string,
    @Body() body: ChangeRequestResendDto,
  ): Promise<{ reconfirmation: ReconfirmationView }> {
    return {
      reconfirmation: await this.merchant.resend(user, verificationId, body),
    };
  }
}
