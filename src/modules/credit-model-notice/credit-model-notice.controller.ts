import {
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import { CreditModelNoticeService } from './credit-model-notice.service';

@Controller('api/billing/credit-model-notice')
@UseGuards(DualAuthGuard)
export class CreditModelNoticeController {
  constructor(private readonly notices: CreditModelNoticeService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentUser() user: AuthenticatedUser) {
    return this.notices.read(user);
  }

  @Post('dismiss')
  @HttpCode(204)
  dismiss(@CurrentUser() user: AuthenticatedUser) {
    return this.notices.dismiss(user);
  }
}
