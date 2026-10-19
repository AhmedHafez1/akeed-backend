import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import {
  ReviewPromptActionDto,
  type ReviewPromptActionResponseDto,
  type ReviewPromptStateResponseDto,
} from './dto/review-prompt.dto';
import { ReviewPromptService } from './review-prompt.service';

@Controller('api/review-prompt')
@UseGuards(DualAuthGuard)
export class ReviewPromptController {
  constructor(private readonly reviewPrompt: ReviewPromptService) {}

  @Get()
  getState(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReviewPromptStateResponseDto> {
    return this.reviewPrompt.getState(user);
  }

  /** The card's impression, CTA click, Reviews API result or "Not now". */
  @Post('actions')
  @HttpCode(HttpStatus.OK)
  recordAction(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: ReviewPromptActionDto,
    @Headers('x-request-id') httpRequestId?: string,
  ): Promise<ReviewPromptActionResponseDto> {
    return this.reviewPrompt.recordAction(
      user,
      payload.action,
      payload.code,
      httpRequestId,
    );
  }
}
