import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import {
  TipsCardsQueryDto,
  type TipsCardsResponseDto,
  type TipsEventResponseDto,
} from './dto/tips.dto';
import { TipsService } from './tips.service';

@Controller('api/tips')
@UseGuards(DualAuthGuard)
export class TipsController {
  constructor(private readonly tips: TipsService) {}

  @Get()
  getCards(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TipsCardsQueryDto,
  ): Promise<TipsCardsResponseDto> {
    return this.tips.getCards(user, query.locale);
  }

  /** The card was on screen. */
  @Post(':id/view')
  @HttpCode(HttpStatus.OK)
  view(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TipsEventResponseDto> {
    return this.tips.recordEvent(user, id, 'view');
  }

  /** The card's button was clicked; navigation does not wait for this. */
  @Post(':id/click')
  @HttpCode(HttpStatus.OK)
  click(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TipsEventResponseDto> {
    return this.tips.recordEvent(user, id, 'click');
  }

  /** Hides the card for the whole account, permanently. */
  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  dismiss(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TipsEventResponseDto> {
    return this.tips.recordEvent(user, id, 'dismiss');
  }
}
