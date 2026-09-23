import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import { OnboardingTestService } from './onboarding-test.service';
import {
  SendOnboardingTestDto,
  type OnboardingTestStatusDto,
} from './dto/onboarding-test.dto';

@Controller('api/onboarding/test')
@UseGuards(DualAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
)
export class OnboardingTestController {
  constructor(private readonly onboardingTestService: OnboardingTestService) {}

  @Get()
  async getStatus(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OnboardingTestStatusDto> {
    return this.onboardingTestService.getStatus(user);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: SendOnboardingTestDto,
  ): Promise<OnboardingTestStatusDto> {
    return this.onboardingTestService.send(user, { resend: payload.resend });
  }

  @Post('skip')
  @HttpCode(HttpStatus.OK)
  async skip(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OnboardingTestStatusDto> {
    return this.onboardingTestService.skip(user);
  }
}
