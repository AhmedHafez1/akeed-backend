import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { CreditUsageService } from './credit-usage.service';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';

@Controller('api/billing/credits')
@UseGuards(DualAuthGuard)
export class CreditUsageController {
  constructor(private readonly usage: CreditUsageService) {}

  @Get('usage')
  @Header('Cache-Control', 'private, no-store')
  read(
    @CurrentUser() user: AuthenticatedUser,
    @Query('timeZone') timeZone?: unknown,
  ) {
    return this.usage.read(user.orgId, timeZone);
  }
}
