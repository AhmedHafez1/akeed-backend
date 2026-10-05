import { ConflictException, Injectable } from '@nestjs/common';
import { AdminAccessAuditRepository } from '../../infrastructure/database/repositories/admin-access-audit.repository';
import type { TemplateSyncRun } from '../../infrastructure/database/repositories/whatsapp-template-sync.repository';
import { WhatsappTemplateSyncService } from '../template-registry/whatsapp-template-sync.service';
import { WHATSAPP_TEMPLATE_ERROR_CODES } from './whatsapp-template-operator.guard';

export const WHATSAPP_TEMPLATE_SYNC_AUDIT_ACTION =
  'whatsapp-templates.sync.run';

/** A sync run as staff see it: counts and neutral codes, no provider text. */
export interface AdminTemplateSyncRunView {
  id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  provider_template_count: number | null;
  updated_count: number | null;
  unchanged_count: number | null;
  missing_keys: string[];
  unknown_at_provider: { template_name: string; language_code: string }[];
}

export function toSyncRunView(run: TemplateSyncRun): AdminTemplateSyncRunView {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    error_code: run.errorCode,
    provider_template_count: run.providerTemplateCount,
    updated_count: run.updatedCount,
    unchanged_count: run.unchangedCount,
    missing_keys: run.missingKeys ?? [],
    unknown_at_provider: (run.unknownAtProvider ?? []).map((entry) => ({
      template_name: entry.templateName,
      language_code: entry.languageCode,
    })),
  };
}

@Injectable()
export class AdminTemplatesService {
  constructor(
    private readonly sync: WhatsappTemplateSyncService,
    private readonly audit: AdminAccessAuditRepository,
  ) {}

  /**
   * Runs a sync now for a named operator and audits it. A refused sync
   * (switched off, already running, too soon after the last one) is a 409
   * with a stable code; a sync that ran and failed is a 200 whose run says
   * `failed`, so the failure is visible.
   */
  async runSync(
    userId: string,
    requestId?: string,
  ): Promise<AdminTemplateSyncRunView> {
    const result = await this.sync.runSync('manual', userId);
    if (result.outcome === 'disabled') {
      throw this.conflict(
        WHATSAPP_TEMPLATE_ERROR_CODES.syncDisabled,
        'WhatsApp template sync is disabled.',
      );
    }
    if (result.outcome === 'in_progress') {
      throw this.conflict(
        WHATSAPP_TEMPLATE_ERROR_CODES.syncInProgress,
        'A WhatsApp template sync is already running.',
      );
    }
    if (result.outcome === 'cooldown') {
      throw this.conflict(
        WHATSAPP_TEMPLATE_ERROR_CODES.syncCooldown,
        'A WhatsApp template sync finished moments ago.',
        { retry_after_seconds: result.retryAfterSeconds },
      );
    }
    await this.audit.record({
      userId,
      action: WHATSAPP_TEMPLATE_SYNC_AUDIT_ACTION,
      outcome: 'allowed',
      requestId,
      metadata: {
        runId: result.run.id,
        status: result.run.status,
        errorCode: result.run.errorCode,
        updatedCount: result.run.updatedCount,
        missingCount: result.run.missingKeys?.length ?? 0,
        unknownAtProviderCount: result.run.unknownAtProvider?.length ?? 0,
      },
    });
    return toSyncRunView(result.run);
  }

  async recentRuns(): Promise<{
    sync_enabled: boolean;
    runs: AdminTemplateSyncRunView[];
  }> {
    const runs = await this.sync.recentRuns(20);
    return {
      sync_enabled: this.sync.isEnabled(),
      runs: runs.map(toSyncRunView),
    };
  }

  private conflict(
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): ConflictException {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message,
      code,
      ...extra,
    });
  }
}
