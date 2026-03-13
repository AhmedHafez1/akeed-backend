import {
  BadRequestException,
  Controller,
  Get,
  Redirect,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { OnboardingService } from './onboarding.service';
import { BillingCallbackRateLimitGuard } from '../../shared/guards/billing-callback-rate-limit.guard';
import { ShopifyBillingCallbackValidationGuard } from '../../shared/guards/shopify-billing-callback-validation.guard';

interface BillingCallbackQuery {
  shop?: string | string[];
  charge_id?: string | string[];
  host?: string | string[];
}

@Controller('api/onboarding/billing')
export class OnboardingBillingCallbackController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @UseGuards(
    BillingCallbackRateLimitGuard,
    ShopifyBillingCallbackValidationGuard,
  )
  @Get('callback')
  @Redirect()
  async billingCallback(
    @Req() req: Request,
  ): Promise<{ url: string; statusCode: number }> {
    const query = req.query as unknown as BillingCallbackQuery;
    const shop = this.getSingleQueryParam(query.shop);
    const chargeId = this.getSingleQueryParam(query.charge_id);
    const host = this.getSingleQueryParam(query.host);

    if (!shop || !chargeId) {
      // Validation guard should prevent this path; keep a safe fallback.
      throw new BadRequestException('Invalid billing callback query');
    }

    const redirectUrl = await this.onboardingService.handleBillingCallback({
      shop,
      chargeId,
      host,
    });
    return { url: redirectUrl, statusCode: 302 };
  }

  private getSingleQueryParam(
    value: string | string[] | undefined,
  ): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value) && value.length > 0) {
      return value[0];
    }

    return undefined;
  }
}
