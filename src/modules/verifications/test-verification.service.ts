import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import { PhoneService } from '../../shared/services/phone.service';
import { InvalidPhoneNumberError } from '../../shared/errors/invalid-phone-number.error';

const DEFAULT_SHIPPING_CURRENCY = 'USD';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const TEST_LIMIT_COUNT = 3;
const TEST_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class TestVerificationService {
  private readonly rateLimits = new Map<string, RateLimitEntry>();

  constructor(
    private readonly configService: ConfigService,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly verificationHubService: VerificationHubService,
    private readonly phoneService: PhoneService,
  ) {}

  async sendTestVerification(
    orgId: string,
    customerPhone: string,
  ): Promise<{
    skipped?: boolean;
    reason?: string;
    orderId?: string;
    verificationId?: string;
  }> {
    this.checkAndIncrementRateLimit(orgId);

    let normalizedPhone: string;
    try {
      normalizedPhone = this.phoneService.standardize(customerPhone);
    } catch (error) {
      if (error instanceof InvalidPhoneNumberError) {
        throw new BadRequestException(
          'customerPhone must be a valid phone number (example: +201234567890).',
        );
      }
      throw error;
    }

    const integration = await this.integrationsRepo.findActiveByOrgAndPlatform(
      orgId,
      'shopify',
    );

    if (!integration) {
      throw new BadRequestException('No active Shopify integration found.');
    }

    const timestamp = Date.now();
    const testOrderId = `akeed-test-${timestamp}`;
    const defaultCurrency =
      typeof integration.shippingCurrency === 'string' &&
      integration.shippingCurrency.trim().length > 0
        ? integration.shippingCurrency.trim().toUpperCase()
        : DEFAULT_SHIPPING_CURRENCY;

    const result = await this.verificationHubService.handleNewOrder(
      {
        orgId,
        integrationId: integration.id,
        externalOrderId: testOrderId,
        orderNumber: `TEST-${timestamp}`,
        customerPhone: normalizedPhone,
        customerName: 'Test Customer',
        totalPrice: '1.00',
        currency: defaultCurrency,
        paymentMethod: 'cod',
        rawPayload: {
          source: 'dashboard_test_verification',
          createdAt: new Date().toISOString(),
        },
      },
      integration,
    );

    if ('skipped' in result && result.skipped) {
      return {
        skipped: true,
        reason: result.reason,
      };
    }

    return {
      orderId: result.orderId,
      verificationId: result.verificationId,
    };
  }

  private checkAndIncrementRateLimit(orgId: string) {
    const now = Date.now();
    const current = this.rateLimits.get(orgId);

    if (current && current.resetAt > now) {
      if (current.count >= TEST_LIMIT_COUNT) {
        throw new BadRequestException(
          'You have reached the limit of 3 test verifications per 24 hours. Please try again later.',
        );
      }
      current.count++;
    } else {
      this.rateLimits.set(orgId, {
        count: 1,
        resetAt: now + TEST_LIMIT_WINDOW_MS,
      });
    }
  }
}
