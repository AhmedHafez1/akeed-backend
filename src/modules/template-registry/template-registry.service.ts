import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import { WhatsappTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import type { TemplateRegistryPort } from '../../shared/ports/template-registry.port';

/** How long a loaded copy of the registry is served before it is read again. */
export const TEMPLATE_REGISTRY_CACHE_TTL_MS = 60_000;

/**
 * Serves the template registry from a short-lived in-memory copy, so a send
 * does not add a query per message. A staff write calls `invalidate()`; other
 * instances pick the change up when their copy expires.
 *
 * When a refresh fails, the last good copy keeps being served: templates
 * change rarely, and a stale list is safer than stopping every send. With no
 * copy at all the error propagates, like any other read before the claim.
 */
@Injectable()
export class TemplateRegistryService implements TemplateRegistryPort {
  private readonly logger = new Logger(TemplateRegistryService.name);
  private cached: {
    templates: readonly RegistryTemplate[];
    loadedAt: number;
  } | null = null;
  private loading: Promise<readonly RegistryTemplate[]> | null = null;

  constructor(
    private readonly templatesRepo: WhatsappTemplatesRepository,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** `WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED`, off without a configuration. */
  sendGuardrailEnabled(): boolean {
    return this.config
      ? readWhatsappTemplateConfig(this.config).guardrailEnabled
      : false;
  }

  async listTemplates(): Promise<readonly RegistryTemplate[]> {
    const cached = this.cached;
    if (
      cached &&
      Date.now() - cached.loadedAt < TEMPLATE_REGISTRY_CACHE_TTL_MS
    ) {
      return cached.templates;
    }

    try {
      return await this.load();
    } catch (error) {
      if (!cached) throw error;
      this.logger.warn(
        buildBackendLog(TemplateRegistryService.name, {
          action: 'template-registry-refresh',
          outcome: 'failure',
          servedStale: true,
          ...normalizeError(error),
        }),
      );
      return cached.templates;
    }
  }

  invalidate(): void {
    this.cached = null;
  }

  /** Concurrent callers share one read. */
  private load(): Promise<readonly RegistryTemplate[]> {
    this.loading ??= this.templatesRepo
      .findAll()
      .then((templates) => {
        this.cached = { templates, loadedAt: Date.now() };
        return templates;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }
}
