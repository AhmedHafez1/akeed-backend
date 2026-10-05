import { Injectable, Logger } from '@nestjs/common';
import { WhatsappTemplateSyncRepository } from '../../infrastructure/database/repositories/whatsapp-template-sync.repository';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type {
  ProviderState,
  SyncedTemplateRow,
} from '../../shared/messaging/template-provider.types';
import { isProviderSendable, isRecategorized } from './template-sync.rules';

export type TemplateAlertCode =
  | 'template_unavailable'
  | 'template_recategorized'
  | 'template_text_changed'
  | 'template_sync_failed';

/** Every alert code, for the docs and the alert specs. */
export const TEMPLATE_ALERT_CODES: readonly TemplateAlertCode[] = [
  'template_unavailable',
  'template_recategorized',
  'template_text_changed',
  'template_sync_failed',
];

export interface TemplateTransition {
  row: SyncedTemplateRow;
  before: ProviderState;
  after: ProviderState;
  drift: boolean;
}

/**
 * Staff alerts for templates (US-08-04 criterion 6), as structured log lines
 * like the billing alerts. The per-store side of the same signal is the
 * `template_unavailable` admin health rule.
 *
 * An alert fires on a change, not on a state: a template that becomes
 * unsendable, a category change, or new text at the provider. Only a template
 * in use alerts: a language default, or one at least one active store sends.
 * A line names the template key, its neutral state and how many stores send
 * it. It never carries template text or anything about a customer.
 */
@Injectable()
export class TemplateAlertService {
  private readonly logger = new Logger(TemplateAlertService.name);

  constructor(private readonly repository: WhatsappTemplateSyncRepository) {}

  async evaluate(transitions: readonly TemplateTransition[]): Promise<void> {
    const raised = transitions.flatMap((transition) =>
      this.codesFor(transition).map((code) => ({ code, transition })),
    );
    if (raised.length === 0) return;
    const counts = await this.repository.activeStoreCountsByKey([
      ...new Set(raised.map(({ transition }) => transition.row.key)),
    ]);
    for (const { code, transition } of raised) {
      const stores = counts.get(transition.row.key) ?? 0;
      if (!transition.row.isDefault && stores === 0) continue;
      this.alert(
        code,
        code === 'template_text_changed' ? 'attention' : 'critical',
        {
          templateKey: transition.row.key,
          reviewStatus: transition.after.reviewStatus,
          category: transition.after.category,
          pendingCategory: transition.after.pendingCategory,
          isDefault: transition.row.isDefault,
          affectedStoreCount: stores,
        },
      );
    }
  }

  syncFailed(errorCode: string, trigger: string): void {
    this.alert('template_sync_failed', 'attention', { errorCode, trigger });
  }

  private codesFor(transition: TemplateTransition): TemplateAlertCode[] {
    const codes: TemplateAlertCode[] = [];
    if (
      isProviderSendable(transition.before) &&
      !isProviderSendable(transition.after)
    ) {
      codes.push('template_unavailable');
    }
    if (
      !isRecategorized(transition.row.purpose, transition.before) &&
      isRecategorized(transition.row.purpose, transition.after)
    ) {
      codes.push('template_recategorized');
    }
    if (transition.drift) codes.push('template_text_changed');
    return codes;
  }

  private alert(
    alertCode: TemplateAlertCode,
    severity: 'attention' | 'critical',
    context: Record<string, unknown>,
  ): void {
    this.logger.warn(
      buildBackendLog(TemplateAlertService.name, {
        action: 'whatsapp-template-alert',
        outcome: 'failure',
        alertCode,
        severity,
        ...context,
      }),
    );
  }
}
