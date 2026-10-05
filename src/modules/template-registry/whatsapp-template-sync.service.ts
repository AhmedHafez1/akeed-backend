import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WhatsappTemplateSyncRepository,
  type TemplateSyncRun,
  type TemplateSyncTrigger,
} from '../../infrastructure/database/repositories/whatsapp-template-sync.repository';
import { readWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  TEMPLATE_CATALOG_PORT,
  TemplateCatalogError,
  type TemplateCatalogPort,
} from '../../shared/ports/template-catalog.port';
import {
  TEMPLATE_REGISTRY_PORT,
  type TemplateRegistryPort,
} from '../../shared/ports/template-registry.port';
import type { ProviderTemplateRecord } from '../../shared/messaging/template-provider.types';
import { TemplateAlertService } from './template-alert.service';
import { planSync, providerState } from './template-sync.rules';

/** A manual sync is refused this soon after the last one finished (4.9.5). */
export const MANUAL_SYNC_COOLDOWN_MS = 5 * 60_000;

export type TemplateSyncResult =
  | { outcome: 'disabled' }
  | { outcome: 'in_progress' }
  | { outcome: 'cooldown'; retryAfterSeconds: number; lastRun: TemplateSyncRun }
  | { outcome: 'succeeded' | 'failed'; run: TemplateSyncRun };

/**
 * Reads every template from the provider and records what it says on the
 * matching registry rows (US-08-04 criterion 2).
 *
 * - The provider's list is read in full before anything is written. A read
 *   that fails, a rate limit included, records a failed run with a neutral
 *   code and an alert, and changes no registry row. It is not retried; the
 *   next scheduled run tries again.
 * - Rows are matched by provider name and language code. A row with no
 *   provider template is marked `missing`. A provider template with no row is
 *   reported on the run, never created.
 * - One run at a time across every instance. Running it again with the same
 *   provider data changes nothing.
 */
@Injectable()
export class WhatsappTemplateSyncService {
  private readonly logger = new Logger(WhatsappTemplateSyncService.name);

  constructor(
    private readonly repository: WhatsappTemplateSyncRepository,
    @Inject(TEMPLATE_CATALOG_PORT)
    private readonly catalog: TemplateCatalogPort,
    @Inject(TEMPLATE_REGISTRY_PORT)
    private readonly registry: TemplateRegistryPort,
    private readonly alerts: TemplateAlertService,
    private readonly config: ConfigService,
  ) {}

  isEnabled(): boolean {
    return readWhatsappTemplateConfig(this.config).syncEnabled;
  }

  async runSync(
    trigger: TemplateSyncTrigger,
    requestedBy: string | null = null,
  ): Promise<TemplateSyncResult> {
    if (!this.isEnabled()) return { outcome: 'disabled' };
    if (trigger === 'manual') {
      const last = await this.repository.lastFinishedRun();
      const finishedAt = last?.finishedAt ? Date.parse(last.finishedAt) : NaN;
      const waitMs = finishedAt + MANUAL_SYNC_COOLDOWN_MS - Date.now();
      if (last && waitMs > 0) {
        return {
          outcome: 'cooldown',
          retryAfterSeconds: Math.ceil(waitMs / 1000),
          lastRun: last,
        };
      }
    }
    const run = await this.repository.startRun(trigger, requestedBy);
    if (!run) return { outcome: 'in_progress' };

    let records: ProviderTemplateRecord[];
    try {
      records = await this.catalog.listTemplates();
    } catch (error) {
      const code =
        error instanceof TemplateCatalogError ? error.code : 'provider_error';
      return this.fail(run, code, trigger, error);
    }

    try {
      const rows = await this.repository.listRows();
      const plan = planSync(rows, records);
      const updated = plan.rows.filter((entry) => entry.changed);
      const finished = await this.repository.completeSync({
        run,
        rows: plan.rows.map(({ row, next, drift }) => ({
          id: row.id,
          next,
          drift,
        })),
        providerTemplateCount: records.length,
        updatedCount: updated.length,
        missingKeys: plan.missingKeys,
        unknownAtProvider: plan.unknownAtProvider,
      });
      this.registry.invalidate();
      this.logger.log(
        buildBackendLog(WhatsappTemplateSyncService.name, {
          action: 'whatsapp-template-sync',
          outcome: 'success',
          runId: run.id,
          trigger,
          providerTemplateCount: records.length,
          updatedCount: updated.length,
          unchangedCount: plan.rows.length - updated.length,
          missingCount: plan.missingKeys.length,
          unknownAtProviderCount: plan.unknownAtProvider.length,
        }),
      );
      await this.alerts.evaluate(
        plan.rows.map(({ row, next, drift }) => ({
          row,
          before: providerState(row),
          after: next,
          drift,
        })),
      );
      return { outcome: 'succeeded', run: finished };
    } catch (error) {
      return this.fail(run, 'persistence_failed', trigger, error);
    }
  }

  recentRuns(limit = 20): Promise<TemplateSyncRun[]> {
    return this.repository.recentRuns(limit);
  }

  private async fail(
    run: TemplateSyncRun,
    errorCode: string,
    trigger: TemplateSyncTrigger,
    error: unknown,
  ): Promise<TemplateSyncResult> {
    this.logger.warn(
      buildBackendLog(WhatsappTemplateSyncService.name, {
        action: 'whatsapp-template-sync',
        outcome: 'failure',
        runId: run.id,
        trigger,
        errorCode,
        ...(error instanceof TemplateCatalogError
          ? { providerCode: error.providerCode }
          : { errorName: normalizeError(error).errorName }),
      }),
    );
    this.alerts.syncFailed(errorCode, trigger);
    const failed = await this.repository.failRun(run.id, errorCode);
    return { outcome: 'failed', run: failed };
  }
}
