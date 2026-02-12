import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OnboardingService } from '../services/onboarding.service';

@Controller('api/onboarding/billing')
export class OnboardingBillingCallbackController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('callback')
  async billingCallback(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const redirectUrl = await this.onboardingService.handleBillingCallback(
      req.query as Record<string, string | undefined>,
    );
    res.redirect(redirectUrl);
  }
}
