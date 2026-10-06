import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MessageTextConflictError,
  WhatsappMessageTextsRepository,
} from '../../infrastructure/database/repositories/whatsapp-message-texts.repository';
import {
  isWhatsappTemplateOperator,
  readWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import {
  DEFAULT_MESSAGE_TEXT_STYLE,
  MESSAGE_TEXT_MAX_LENGTH,
  MESSAGE_TEXT_PURPOSES,
  type MessageText,
  type MessageTextPurpose,
} from '../../shared/messaging/message-texts.types';
import { TEMPLATE_LANGUAGES } from '../../shared/messaging/template-registry.types';
import { MessageTextsService } from '../message-texts/message-texts.service';
import type { AdminMessageTextDto } from './dto/admin-message-texts.dto';

export const MESSAGE_TEXT_AUDIT_ACTION = 'whatsapp-message-texts.save';

export const MESSAGE_TEXT_ERROR_CODES = {
  invalid: 'WHATSAPP_MESSAGE_TEXT_INVALID',
  conflict: 'WHATSAPP_MESSAGE_TEXT_CONFLICT',
} as const;

/** A name stands in for a store or customer name: kept as short as one. */
const FALLBACK_MAX_LENGTH = 60;

/** The placeholders each purpose may use. A name fallback uses none. */
const PURPOSE_VARIABLES: Record<MessageTextPurpose, readonly string[]> = {
  ack_confirmed: ['order', 'store'],
  ack_canceled: ['order', 'store'],
  unresolved_reply_nudge: ['order', 'store'],
  fallback_customer_name: [],
  fallback_store_name: [],
};

const TOKEN = /{{([^{}]*)}}/g;

export interface AdminMessageTextView {
  id: string;
  purpose: MessageTextPurpose;
  language: string;
  style: string;
  body: string;
  is_active: boolean;
  updated_at: string;
}

function toView(text: MessageText): AdminMessageTextView {
  return {
    id: text.id,
    purpose: text.purpose,
    language: text.language,
    style: text.style,
    body: text.body,
    is_active: text.isActive,
    updated_at: text.updatedAt,
  };
}

/**
 * The free-form texts staff manage (US-08-07): the acknowledgment, the nudge
 * and the name fallbacks. Reads are open to staff; writes need a named
 * template operator, checked by the controller's guard.
 */
@Injectable()
export class AdminMessageTextsService {
  private readonly logger = new Logger(AdminMessageTextsService.name);

  constructor(
    private readonly repository: WhatsappMessageTextsRepository,
    private readonly texts: MessageTextsService,
    private readonly config: ConfigService,
  ) {}

  async list(userId: string) {
    const config = readWhatsappTemplateConfig(this.config);
    const switches = config.messageImprovements;
    return {
      operations: {
        enabled: config.operationsEnabled,
        operator: isWhatsappTemplateOperator(config, userId),
      },
      switches: {
        acknowledgment: switches.acknowledgment,
        unresolved_reply_nudge: switches.unresolvedReplyNudge,
        localized_fallbacks: switches.localizedFallbacks,
      },
      options: {
        purposes: MESSAGE_TEXT_PURPOSES,
        languages: TEMPLATE_LANGUAGES,
        default_style: DEFAULT_MESSAGE_TEXT_STYLE,
        variables: PURPOSE_VARIABLES,
        limits: {
          body: MESSAGE_TEXT_MAX_LENGTH,
          fallback: FALLBACK_MAX_LENGTH,
        },
      },
      texts: (await this.repository.findAll()).map(toView),
    };
  }

  async save(userId: string, dto: AdminMessageTextDto, requestId?: string) {
    const rule = this.invalidRule(dto);
    if (rule) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'The text does not meet the rules for its purpose.',
        code: MESSAGE_TEXT_ERROR_CODES.invalid,
        rule,
      });
    }
    let result: Awaited<ReturnType<WhatsappMessageTextsRepository['upsert']>>;
    try {
      result = await this.repository.upsert({
        purpose: dto.purpose,
        language: dto.language,
        style: dto.style,
        body: dto.body,
        isActive: dto.is_active,
        userId,
        requestId,
        auditAction: MESSAGE_TEXT_AUDIT_ACTION,
      });
    } catch (error) {
      if (error instanceof MessageTextConflictError) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'Another operator saved this text at the same time.',
          code: MESSAGE_TEXT_ERROR_CODES.conflict,
        });
      }
      throw error;
    }
    if (result.action !== 'unchanged') this.texts.invalidate();
    this.logger.log(
      buildBackendLog(AdminMessageTextsService.name, {
        action: 'whatsapp-message-text-save',
        outcome: 'success',
        userId,
        requestId,
        purpose: dto.purpose,
        resolvedLanguage: dto.language,
        style: dto.style,
        change: result.action,
      }),
    );
    return { change: result.action, text: toView(result.text) };
  }

  /** The first rule a text breaks, as a stable code the UI translates. */
  private invalidRule(dto: AdminMessageTextDto): string | null {
    if (!dto.body) return 'body_empty';
    const allowed = PURPOSE_VARIABLES[dto.purpose];
    const isFallback = allowed.length === 0;
    if (isFallback && dto.body.length > FALLBACK_MAX_LENGTH) {
      return 'fallback_too_long';
    }
    if (isFallback && dto.style !== DEFAULT_MESSAGE_TEXT_STYLE) {
      return 'fallback_default_style_only';
    }
    if (isFallback && /\r|\n/.test(dto.body)) return 'fallback_single_line';
    for (const match of dto.body.matchAll(TOKEN)) {
      if (!allowed.includes(match[1].trim())) return 'variable_not_allowed';
    }
    if (/{{|}}/.test(dto.body.replace(TOKEN, ''))) return 'variable_malformed';
    return null;
  }
}
