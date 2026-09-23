import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { ProductEventsRepository } from '../../infrastructure/database/repositories/product-events.repository';
import { AdminStoreLifecyclesRepository } from '../../infrastructure/database/repositories/admin-store-lifecycles.repository';
import { integrations } from '../../infrastructure/database/schema';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';
import { SYNTHETIC_TEST_ORDER_ID_PREFIX } from '../../shared/commerce/synthetic-order';
import {
  resolveFallbackActiveIntegration,
  resolveShopifyLinkedIntegration,
} from '../../shared/commerce/current-integration-resolver';
import {
  ONBOARDING_TEST_COOLDOWN_SECONDS,
  ONBOARDING_TEST_DAILY_LIMIT,
  ONBOARDING_TEST_SEND_EVENTS,
} from '../../shared/analytics/product-events';
import { resolveTemplateLanguageForPhone } from '../../shared/messaging/template-language';
import {
  getCodTemplateDefinition,
  isArabicCodTemplateVariant,
  isEnglishCodTemplateVariant,
} from '../../shared/messaging/cod-template-catalog';
import type { VerificationStatus } from '../../shared/interfaces/verification.interface';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type {
  OnboardingTestAttemptDto,
  OnboardingTestStatusDto,
} from './dto/onboarding-test.dto';

type IntegrationRecord = typeof integrations.$inferSelect;

const ONBOARDING_TEST_ORDER_NUMBER = 'TEST-1';
const ONBOARDING_TEST_TOTAL = '250.00';
const DEFAULT_SHIPPING_CURRENCY = 'USD';
const SAMPLE_CUSTOMER_NAMES = { ar: 'أحمد', en: 'Ahmed' } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The onboarding "aha" step: a free confirmation message to the merchant's
 * own WhatsApp, polled by the setup screen until the merchant taps Confirm.
 */
@Injectable()
export class OnboardingTestService {
  private readonly logger = new Logger(OnboardingTestService.name);

  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly verificationsRepo: VerificationsRepository,
    private readonly verificationHub: VerificationHubService,
    private readonly productEvents: ProductEventsRepository,
    private readonly adminLifecycles: AdminStoreLifecyclesRepository,
  ) {}

  async send(
    user: AuthenticatedUser,
    options: { resend?: boolean } = {},
  ): Promise<OnboardingTestStatusDto> {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to send a test message.',
      code: 'TEST_VERIFICATION_ROLE_REQUIRED',
    });
    const integration = await this.resolveCurrentSource(user);
    const phone = integration.merchantWhatsappPhone;
    if (!phone) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Add your WhatsApp number in setup before sending a test.',
        code: 'ONBOARDING_TEST_PHONE_MISSING',
      });
    }
    await this.assertSendAllowed(integration.id);

    const language = resolveTemplateLanguageForPhone(
      integration.defaultLanguage,
      phone,
    );
    await this.adminLifecycles.markMilestone(
      integration.id,
      'testRequestedAt',
      undefined,
      { test_requested: 'captured_exact' },
    );

    const result = await this.verificationHub.handleSyntheticTestOrder(
      {
        orgId: user.orgId,
        integrationId: integration.id,
        externalOrderId: `${SYNTHETIC_TEST_ORDER_ID_PREFIX}${randomUUID()}`,
        orderNumber: ONBOARDING_TEST_ORDER_NUMBER,
        customerPhone: phone,
        customerName: SAMPLE_CUSTOMER_NAMES[language],
        totalPrice: ONBOARDING_TEST_TOTAL,
        currency: this.resolveCurrency(integration),
        paymentMethod: 'cod',
        rawPayload: {
          source: 'onboarding_test',
          synthetic: true,
          externalCommerceActionAllowed: false,
          createdAt: new Date().toISOString(),
        },
      },
      integration,
      'onboarding',
    );

    if ('skipped' in result || result.deliveryStatus !== 'sent') {
      const reason =
        'skipped' in result ? result.reason : (result.reason ?? 'unknown');
      this.logger.warn(
        buildBackendLog(OnboardingTestService.name, {
          action: 'onboarding-test-send',
          outcome: 'failure',
          orgId: user.orgId,
          integrationId: integration.id,
          reason,
        }),
      );
      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        message:
          'WhatsApp could not accept the test message. Check the number and try again.',
        code: 'TEST_VERIFICATION_PROVIDER_FAILED',
      });
    }

    await this.adminLifecycles.recordEvent(
      integration.id,
      options.resend ? 'test_resend' : 'test_sent',
      { verificationId: result.verificationId, language },
    );
    await this.adminLifecycles.markMilestone(
      integration.id,
      'testSentAt',
      undefined,
      { test_sent: 'captured_exact' },
    );
    this.logger.log(
      buildBackendLog(OnboardingTestService.name, {
        action: 'onboarding-test-send',
        outcome: 'success',
        orgId: user.orgId,
        integrationId: integration.id,
        verificationId: result.verificationId,
        resend: options.resend === true,
      }),
    );

    return this.buildStatus(integration, user.orgId);
  }

  async getStatus(user: AuthenticatedUser): Promise<OnboardingTestStatusDto> {
    const integration = await this.resolveCurrentSource(user);
    return this.buildStatus(integration, user.orgId);
  }

  async skip(user: AuthenticatedUser): Promise<OnboardingTestStatusDto> {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to skip the test message.',
      code: 'TEST_VERIFICATION_ROLE_REQUIRED',
    });
    const integration = await this.resolveCurrentSource(user);
    await this.adminLifecycles.reachMilestone(
      integration.id,
      'testSkippedAt',
      'test_skipped',
      { provenance: { test_skipped: 'captured_exact' } },
    );
    return this.buildStatus(integration, user.orgId);
  }

  private async assertSendAllowed(integrationId: string): Promise<void> {
    const now = Date.now();
    const latest = await this.productEvents.findLatest({
      integrationId,
      names: ONBOARDING_TEST_SEND_EVENTS,
    });
    const availableAt = this.resendAvailableAt(latest?.createdAt);
    if (availableAt && availableAt.getTime() > now) {
      this.throwRateLimited(
        'ONBOARDING_TEST_COOLDOWN',
        'Wait a few seconds before sending another test message.',
        Math.ceil((availableAt.getTime() - now) / 1000),
      );
    }

    const sentToday = await this.productEvents.countSince({
      integrationId,
      names: ONBOARDING_TEST_SEND_EVENTS,
      since: new Date(now - DAY_MS).toISOString(),
    });
    if (sentToday >= ONBOARDING_TEST_DAILY_LIMIT) {
      this.throwRateLimited(
        'ONBOARDING_TEST_DAILY_LIMIT',
        'The daily limit for test messages was reached. Try again tomorrow.',
      );
    }
  }

  private throwRateLimited(
    code: string,
    message: string,
    retryAfterSeconds?: number,
  ): never {
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message,
        code,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async buildStatus(
    integration: IntegrationRecord,
    orgId: string,
  ): Promise<OnboardingTestStatusDto> {
    const phone = integration.merchantWhatsappPhone ?? null;
    const language = resolveTemplateLanguageForPhone(
      integration.defaultLanguage,
      phone ?? '',
    );
    const lifecycle = await this.adminLifecycles.findCurrent(integration.id);
    // Rate limits span reinstalls; the displayed test does not, or a previous
    // install's confirmed test would read as this install's confirmation.
    const [latest, latestThisInstall, sentToday] = await Promise.all([
      this.productEvents.findLatest({
        integrationId: integration.id,
        names: ONBOARDING_TEST_SEND_EVENTS,
      }),
      lifecycle
        ? this.productEvents.findLatest({
            integrationId: integration.id,
            names: ONBOARDING_TEST_SEND_EVENTS,
            since: lifecycle.installedAt,
          })
        : undefined,
      this.productEvents.countSince({
        integrationId: integration.id,
        names: ONBOARDING_TEST_SEND_EVENTS,
        since: new Date(Date.now() - DAY_MS).toISOString(),
      }),
    ]);

    const verificationId =
      typeof latestThisInstall?.props === 'object' &&
      latestThisInstall.props !== null &&
      'verificationId' in latestThisInstall.props &&
      typeof latestThisInstall.props.verificationId === 'string'
        ? latestThisInstall.props.verificationId
        : null;
    const verification = verificationId
      ? await this.verificationsRepo.findByIdForOrg(verificationId, orgId)
      : undefined;
    const test: OnboardingTestAttemptDto | null = verification
      ? {
          verificationId: verification.id,
          status: verification.status as VerificationStatus,
          sentAt: verification.lastSentAt ?? null,
          deliveredAt: verification.deliveredAt ?? null,
          readAt: verification.readAt ?? null,
          confirmedAt: verification.confirmedAt ?? null,
          canceledAt: verification.canceledAt ?? null,
        }
      : null;

    const template = getCodTemplateDefinition({
      language,
      selection: {
        ar: isArabicCodTemplateVariant(integration.codTemplateArVariant)
          ? integration.codTemplateArVariant
          : undefined,
        en: isEnglishCodTemplateVariant(integration.codTemplateEnVariant)
          ? integration.codTemplateEnVariant
          : undefined,
      },
    });

    return {
      phone,
      language,
      preview: template.preview,
      sample: {
        customerName: SAMPLE_CUSTOMER_NAMES[language],
        orderNumber: ONBOARDING_TEST_ORDER_NUMBER,
        total: '250',
        currency: this.resolveCurrency(integration),
        storeName: integration.storeName?.trim() || '',
      },
      test,
      resendAvailableAt:
        this.resendAvailableAt(latest?.createdAt)?.toISOString() ?? null,
      sendsRemainingToday: Math.max(0, ONBOARDING_TEST_DAILY_LIMIT - sentToday),
      testConfirmedAt: lifecycle?.testConfirmedAt ?? null,
      testSkippedAt: lifecycle?.testSkippedAt ?? null,
    };
  }

  private resendAvailableAt(lastSentAt: string | undefined): Date | null {
    if (!lastSentAt) return null;
    return new Date(
      new Date(lastSentAt).getTime() + ONBOARDING_TEST_COOLDOWN_SECONDS * 1000,
    );
  }

  private resolveCurrency(integration: IntegrationRecord): string {
    const currency = integration.shippingCurrency?.trim();
    return currency ? currency.toUpperCase() : DEFAULT_SHIPPING_CURRENCY;
  }

  private async resolveCurrentSource(
    user: AuthenticatedUser,
  ): Promise<IntegrationRecord> {
    if (user.source === 'shopify' && user.shop) {
      const resolution = await resolveShopifyLinkedIntegration(
        this.integrationsRepo,
        { orgId: user.orgId, shopDomain: user.shop, requireActive: true },
      );
      if (resolution.outcome === 'found') return resolution.integration;
      this.throwSourceUnavailable();
    }

    const resolution = await resolveFallbackActiveIntegration(
      this.integrationsRepo,
      user.orgId,
    );
    if (resolution.outcome === 'found') return resolution.integration;
    this.throwSourceUnavailable();
  }

  private throwSourceUnavailable(): never {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'An active commerce source is required to send a test message.',
      code: 'TEST_VERIFICATION_SOURCE_UNAVAILABLE',
    });
  }
}
