import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { AdminAccessAuditRepository } from '../../infrastructure/database/repositories/admin-access-audit.repository';
import {
  ONBOARDING_TEST_COOLDOWN_SECONDS,
  ONBOARDING_TEST_DAILY_LIMIT,
} from '../../shared/analytics/product-events';
import {
  normalizeTemplateTestPhone,
  readWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { templateSampleValues } from '../../shared/messaging/template-rendering';
import {
  hasSyncedRegistry,
  isSendableTemplate,
  toSelectedTemplate,
} from '../../shared/messaging/template-selector';
import {
  MESSAGING_PORT,
  type MessagingPort,
} from '../../shared/ports/messaging.port';
import {
  TEMPLATE_REGISTRY_PORT,
  type TemplateRegistryPort,
} from '../../shared/ports/template-registry.port';
import { templateNotFound } from './admin-template-inspection.service';
import { WHATSAPP_TEMPLATE_ERROR_CODES } from './whatsapp-template-operator.guard';

export const WHATSAPP_TEMPLATE_TEST_SEND_AUDIT_ACTION =
  'whatsapp-templates.test-send';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sends one template, with sample values, to a staff phone (US-08-05).
 *
 * The message is the one a store would send, through the same messaging port,
 * so staff see exactly what a customer would. Nothing else is created: no
 * order, no verification, no dispatch and no usage. Its buttons carry an ID
 * that belongs to no verification, so a tap on either changes nothing.
 *
 * The only record is one audit row per accepted send, which is also what the
 * limits count. It names the template and never the phone or the text.
 */
@Injectable()
export class AdminTemplateTestSendService {
  private readonly logger = new Logger(AdminTemplateTestSendService.name);

  constructor(
    @Inject(TEMPLATE_REGISTRY_PORT)
    private readonly registry: TemplateRegistryPort,
    @Inject(MESSAGING_PORT)
    private readonly messaging: MessagingPort,
    private readonly audit: AdminAccessAuditRepository,
    private readonly config: ConfigService,
  ) {}

  async send(params: {
    userId: string;
    key: string;
    phone: string;
    requestId?: string;
  }): Promise<{ accepted: true }> {
    const { userId, key } = params;
    const allowed = readWhatsappTemplateConfig(this.config).testPhones;
    if (allowed.size === 0) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Template test sends are not set up in this environment.',
        code: WHATSAPP_TEMPLATE_ERROR_CODES.testSendDisabled,
      });
    }
    const phone = normalizeTemplateTestPhone(params.phone);
    if (!phone || !allowed.has(phone)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'This phone number is not on the template test list.',
        code: WHATSAPP_TEMPLATE_ERROR_CODES.testPhoneNotAllowed,
      });
    }

    const templates = await this.registry.listTemplates();
    const template = templates.find((entry) => entry.key === key);
    if (!template) throw templateNotFound();
    // Stricter than a store's send: once the environment has synced, a test
    // needs the provider's approval whether or not the guardrail is on.
    if (!isSendableTemplate(template, hasSyncedRegistry(templates))) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'This template cannot be sent now.',
        code: WHATSAPP_TEMPLATE_ERROR_CODES.notSendable,
      });
    }
    await this.assertWithinLimits(userId);

    const values = templateSampleValues(template.language);
    try {
      await this.messaging.sendVerificationTemplate({
        to: phone,
        customerName: values.customer,
        storeName: values.store,
        orderNumber: values.order,
        totalPrice: values.total,
        verificationId: randomUUID(),
        template: toSelectedTemplate(template),
      });
    } catch (error) {
      this.logger.warn(
        buildBackendLog(AdminTemplateTestSendService.name, {
          action: 'whatsapp-template-test-send',
          outcome: 'failure',
          userId,
          requestId: params.requestId,
          templateKey: key,
          errorName: normalizeError(error).errorName,
        }),
      );
      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'WhatsApp did not accept the test message.',
        code: WHATSAPP_TEMPLATE_ERROR_CODES.testSendFailed,
      });
    }

    await this.audit.record({
      userId,
      action: WHATSAPP_TEMPLATE_TEST_SEND_AUDIT_ACTION,
      outcome: 'allowed',
      requestId: params.requestId,
      metadata: { templateKey: key, purpose: 'test' },
    });
    this.logger.log(
      buildBackendLog(AdminTemplateTestSendService.name, {
        action: 'whatsapp-template-test-send',
        outcome: 'success',
        userId,
        requestId: params.requestId,
        templateKey: key,
      }),
    );
    return { accepted: true };
  }

  /** The onboarding test's limits, counted per staff member. */
  private async assertWithinLimits(userId: string): Promise<void> {
    const now = Date.now();
    const latest = await this.audit.latestAllowedAt(
      userId,
      WHATSAPP_TEMPLATE_TEST_SEND_AUDIT_ACTION,
    );
    const availableAt = latest
      ? Date.parse(latest) + ONBOARDING_TEST_COOLDOWN_SECONDS * 1000
      : 0;
    if (availableAt > now) {
      this.throwRateLimited(
        WHATSAPP_TEMPLATE_ERROR_CODES.testCooldown,
        'Wait a few seconds before sending another test message.',
        Math.ceil((availableAt - now) / 1000),
      );
    }
    const sentToday = await this.audit.countAllowedSince(
      userId,
      WHATSAPP_TEMPLATE_TEST_SEND_AUDIT_ACTION,
      new Date(now - DAY_MS).toISOString(),
    );
    if (sentToday >= ONBOARDING_TEST_DAILY_LIMIT) {
      this.throwRateLimited(
        WHATSAPP_TEMPLATE_ERROR_CODES.testDailyLimit,
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
        ...(retryAfterSeconds !== undefined
          ? { retry_after_seconds: retryAfterSeconds }
          : {}),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
