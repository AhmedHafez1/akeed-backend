import { Injectable, Logger } from '@nestjs/common';
import { WhatsappMessageTextsRepository } from '../../infrastructure/database/repositories/whatsapp-message-texts.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  DEFAULT_MESSAGE_TEXT_STYLE,
  type MessageText,
  type MessageTextPurpose,
} from '../../shared/messaging/message-texts.types';
import type { TemplateLanguage } from '../../shared/messaging/template-registry.types';

/** How long a loaded copy of the texts is served before it is read again. */
export const MESSAGE_TEXTS_CACHE_TTL_MS = 60_000;

/**
 * Serves the free-form texts (US-08-07) from a short-lived in-memory copy,
 * like the template registry. A staff write calls `invalidate()`; other
 * instances pick the change up when their copy expires. A failed refresh
 * keeps serving the last good copy.
 */
@Injectable()
export class MessageTextsService {
  private readonly logger = new Logger(MessageTextsService.name);
  private cached: { texts: readonly MessageText[]; loadedAt: number } | null =
    null;
  private loading: Promise<readonly MessageText[]> | null = null;

  constructor(private readonly repository: WhatsappMessageTextsRepository) {}

  /**
   * The active text for a purpose and language: the style's own text when it
   * has one, else the language's `default` text, else NULL.
   */
  async resolve(
    purpose: MessageTextPurpose,
    language: TemplateLanguage,
    style?: string | null,
  ): Promise<MessageText | null> {
    const texts = await this.list();
    const find = (wanted: string) =>
      texts.find(
        (text) =>
          text.isActive &&
          text.purpose === purpose &&
          text.language === language &&
          text.style === wanted,
      );
    return (
      (style ? find(style) : undefined) ??
      find(DEFAULT_MESSAGE_TEXT_STYLE) ??
      null
    );
  }

  invalidate(): void {
    this.cached = null;
  }

  private async list(): Promise<readonly MessageText[]> {
    const cached = this.cached;
    if (cached && Date.now() - cached.loadedAt < MESSAGE_TEXTS_CACHE_TTL_MS) {
      return cached.texts;
    }
    try {
      this.loading ??= this.repository
        .findAll()
        .then((texts) => {
          this.cached = { texts, loadedAt: Date.now() };
          return texts;
        })
        .finally(() => {
          this.loading = null;
        });
      return await this.loading;
    } catch (error) {
      if (!cached) throw error;
      this.logger.warn(
        buildBackendLog(MessageTextsService.name, {
          action: 'message-texts-refresh',
          outcome: 'failure',
          servedStale: true,
          ...normalizeError(error),
        }),
      );
      return cached.texts;
    }
  }
}
