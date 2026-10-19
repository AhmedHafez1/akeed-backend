import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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

  @Post(':requestId/impressions')
  @HttpCode(HttpStatus.NO_CONTENT)
  recordShown(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Headers('x-request-id') httpRequestId?: string,
  ): Promise<void> {
    return this.reviewPrompt.recordShown(user, requestId, httpRequestId);
  }

  @Post(':requestId/actions')
  @HttpCode(HttpStatus.OK)
  recordAction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() payload: ReviewPromptActionDto,
    @Headers('x-request-id') httpRequestId?: string,
  ): Promise<ReviewPromptActionResponseDto> {
    return this.reviewPrompt.recordAction(
      user,
      requestId,
      payload.action,
      httpRequestId,
    );
  }
}
