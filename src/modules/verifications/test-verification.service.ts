import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import { PhoneService } from '../../shared/services/phone.service';
import { InvalidPhoneNumberError } from '../../shared/errors/invalid-phone-number.error';
import { AdminStoreLifecyclesRepository } from '../../infrastructure/database/repositories/admin-store-lifecycles.repository';

const DEFAULT_SHIPPING_CURRENCY = 'USD';

@Injectable()
export class TestVerificationService {
  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly verificationHubService: VerificationHubService,
    private readonly phoneService: PhoneService,
    @Optional()
    private readonly adminLifecycles?: AdminStoreLifecyclesRepository,
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
    let normalizedPhone: string;
    try {
      normalizedPhone = this.phoneService.standardize(customerPhone);
    } catch (error) {
      if (error instanceof InvalidPhoneNumberError) {
        throw new BadRequestException(
          'Phone must be a valid phone number (example: +201234567890).',
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

    await this.adminLifecycles?.markMilestone(
      integration.id,
      'testRequestedAt',
      undefined,
      { test_requested: 'captured_exact' },
    );

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

    if ('skipped' in result) {
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
}
