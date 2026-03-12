import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { VerificationHubService } from './verification-hub.service';

const DEFAULT_SHIPPING_CURRENCY = 'USD';

@Injectable()
export class TestVerificationService {
  constructor(
    private readonly configService: ConfigService,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly verificationHubService: VerificationHubService,
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
    if (!this.getBillingTestMode()) {
      throw new BadRequestException(
        'Test verification is available only in billing test mode.',
      );
    }

    const normalizedPhone = customerPhone.trim();
    if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
      throw new BadRequestException(
        'customerPhone must be in E.164 format (example: +201234567890).',
      );
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

  private getBillingTestMode(): boolean {
    return (
      this.configService
        .get<string>('SHOPIFY_BILLING_TEST_MODE', 'false')
        ?.toLowerCase() === 'true'
    );
  }
}
