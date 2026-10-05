import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isWhatsappTemplateOperator,
  readWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type { RequestWithAdmin } from './admin.types';
import { readRequestId } from './standalone-billing-operator.guard';

export const WHATSAPP_TEMPLATE_ERROR_CODES = {
  operationsDisabled: 'WHATSAPP_TEMPLATE_OPERATIONS_DISABLED',
  operatorRequired: 'WHATSAPP_TEMPLATE_OPERATOR_REQUIRED',
  syncDisabled: 'WHATSAPP_TEMPLATE_SYNC_DISABLED',
  syncInProgress: 'WHATSAPP_TEMPLATE_SYNC_IN_PROGRESS',
  syncCooldown: 'WHATSAPP_TEMPLATE_SYNC_COOLDOWN',
  notFound: 'WHATSAPP_TEMPLATE_NOT_FOUND',
  notSendable: 'WHATSAPP_TEMPLATE_NOT_SENDABLE',
  testSendDisabled: 'WHATSAPP_TEMPLATE_TEST_SEND_DISABLED',
  testPhoneNotAllowed: 'WHATSAPP_TEMPLATE_TEST_PHONE_NOT_ALLOWED',
  testCooldown: 'WHATSAPP_TEMPLATE_TEST_COOLDOWN',
  testDailyLimit: 'WHATSAPP_TEMPLATE_TEST_DAILY_LIMIT',
  testSendFailed: 'WHATSAPP_TEMPLATE_TEST_SEND_FAILED',
} as const;

/**
 * Admits a WhatsApp template write only for a named operator (E08; the
 * setting names are the ones US-08-06 defines). Like the billing operator
 * guard it is a method guard, so the controller's `AdminAccessGuard` has
 * already admitted the staff member and set `request.admin`.
 */
@Injectable()
export class WhatsappTemplateOperatorGuard implements CanActivate {
  private readonly logger = new Logger(WhatsappTemplateOperatorGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithAdmin>();
    const templates = readWhatsappTemplateConfig(this.config);
    const code = !templates.operationsEnabled
      ? WHATSAPP_TEMPLATE_ERROR_CODES.operationsDisabled
      : !request.admin?.userId ||
          !isWhatsappTemplateOperator(templates, request.admin.userId)
        ? WHATSAPP_TEMPLATE_ERROR_CODES.operatorRequired
        : null;
    if (!code) return true;
    this.logger.warn(
      buildBackendLog(WhatsappTemplateOperatorGuard.name, {
        action: 'whatsapp-template-operator-check',
        outcome: 'failure',
        userId: request.admin?.userId,
        requestId: readRequestId(request),
        route: `${request.method} ${request.path}`,
        errorCode: code,
      }),
    );
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message:
        code === WHATSAPP_TEMPLATE_ERROR_CODES.operationsDisabled
          ? 'WhatsApp template operations are disabled.'
          : 'A named WhatsApp template operator is required.',
      code,
    });
  }
}
