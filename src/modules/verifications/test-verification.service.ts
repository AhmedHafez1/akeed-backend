import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { MembershipsRepository } from '../../infrastructure/database/repositories/memberships.repository';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import { PhoneService } from '../../shared/services/phone.service';
import { InvalidPhoneNumberError } from '../../shared/errors/invalid-phone-number.error';
import { AdminStoreLifecyclesRepository } from '../../infrastructure/database/repositories/admin-store-lifecycles.repository';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { integrations } from '../../infrastructure/database/schema';

const DEFAULT_SHIPPING_CURRENCY = 'USD';
type IntegrationRecord = typeof integrations.$inferSelect;

@Injectable()
export class TestVerificationService {
  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly verificationHubService: VerificationHubService,
    private readonly phoneService: PhoneService,
    private readonly membershipsRepo: MembershipsRepository,
    @Optional()
    private readonly adminLifecycles?: AdminStoreLifecyclesRepository,
  ) {}

  async sendTestVerification(
    user: AuthenticatedUser,
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
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message:
            'Phone must be a valid phone number (example: +201234567890).',
          code: 'TEST_VERIFICATION_INVALID_PHONE',
        });
      }
      throw error;
    }

    const integration = await this.resolveCurrentSource(user);

    const timestamp = Date.now();
    const testOrderId = `akeed-test-${randomUUID()}`;
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

    const result = await this.verificationHubService.handleSyntheticTestOrder(
      {
        orgId: user.orgId,
        integrationId: integration.id,
        externalOrderId: testOrderId,
        orderNumber: `AKEED-TEST-${timestamp}`,
        customerPhone: normalizedPhone,
        customerName: 'Akeed Test Recipient',
        totalPrice: '1.00',
        currency: defaultCurrency,
        paymentMethod: 'cod',
        rawPayload: {
          source: 'dashboard_test_verification',
          synthetic: true,
          externalCommerceActionAllowed: false,
          createdAt: new Date().toISOString(),
        },
      },
      integration,
    );

    if ('skipped' in result) {
      if (result.reason === 'plan_limit_reached') {
        return { skipped: true, reason: result.reason };
      }
      this.throwReadinessError(result.reason);
    }

    if (result.deliveryStatus !== 'sent') {
      if (result.deliveryStatus === 'plan_limit_reached') {
        return { skipped: true, reason: 'plan_limit_reached' };
      }
      if (result.deliveryStatus === 'skipped') {
        this.throwReadinessError(result.reason ?? 'source_unavailable');
      }
      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        message:
          'WhatsApp could not accept the test message. Check the recipient and try again.',
        code: 'TEST_VERIFICATION_PROVIDER_FAILED',
      });
    }

    return {
      orderId: result.orderId,
      verificationId: result.verificationId,
    };
  }

  private async resolveCurrentSource(
    user: AuthenticatedUser,
  ): Promise<IntegrationRecord> {
    if (user.source === 'shopify' && user.shop) {
      const source = await this.integrationsRepo.findByOrgAndPlatformDomain(
        user.orgId,
        user.shop,
        'shopify',
      );
      if (source?.isActive) return source;
      this.throwSourceUnavailable('The Shopify source is not active.');
    }

    const membership = await this.membershipsRepo.findByOrgAndUser(
      user.orgId,
      user.userId,
    );
    if (membership?.role !== 'owner' && membership?.role !== 'admin') {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Owner or admin role is required to send a test message.',
        code: 'TEST_VERIFICATION_ROLE_REQUIRED',
      });
    }

    const activeSources = await this.integrationsRepo.findActiveByOrg(
      user.orgId,
    );
    if (activeSources.length > 1) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Multiple active commerce sources require staff review.',
        code: 'TEST_VERIFICATION_SOURCE_AMBIGUOUS',
      });
    }

    const source = activeSources[0];
    if (source) return source;

    const existingSources = await this.integrationsRepo.findByOrg(user.orgId);
    const hasInactiveSource = existingSources.some(
      (candidate) => candidate.isActive === false,
    );
    this.throwSourceUnavailable(
      hasInactiveSource
        ? 'The current commerce source is inactive.'
        : 'An active commerce source is required to send a test message.',
    );
  }

  private throwReadinessError(reason: string): never {
    if (reason === 'billing_not_active') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Test messaging access is not active for this source.',
        code: 'TEST_VERIFICATION_ENTITLEMENT_REQUIRED',
      });
    }
    if (reason === 'onboarding_incomplete') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Complete source setup before sending a test message.',
        code: 'TEST_VERIFICATION_SETUP_INCOMPLETE',
      });
    }
    this.throwSourceUnavailable('The current commerce source is not ready.');
  }

  private throwSourceUnavailable(message: string): never {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message,
      code: 'TEST_VERIFICATION_SOURCE_UNAVAILABLE',
    });
  }
}
