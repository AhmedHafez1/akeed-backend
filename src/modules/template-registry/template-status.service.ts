import { Inject, Injectable, Logger } from '@nestjs/common';
import { WhatsappTemplateSyncRepository } from '../../infrastructure/database/repositories/whatsapp-template-sync.repository';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type { TemplateProviderEvent } from '../../shared/messaging/template-provider.types';
import {
  TEMPLATE_REGISTRY_PORT,
  type TemplateRegistryPort,
} from '../../shared/ports/template-registry.port';
import {
  TemplateAlertService,
  type TemplateTransition,
} from './template-alert.service';
import { decideEvent, providerState } from './template-sync.rules';
import { WhatsappTemplateSyncProducer } from './whatsapp-template-sync.producer';

export interface TemplateEventsSummary {
  applied: number;
  stale: number;
  conflict: number;
  unregistered: number;
  duplicate: number;
}

/**
 * Applies template notifications from the provider to the registry
 * (US-08-04 criterion 3), following the contract record's webhook rules:
 *
 * - **Duplicates.** The same event identity twice is a no-op.
 * - **Order.** An event applies only when it is later than the newest one
 *   applied for that template and field; an older one is stored and ignored.
 *   The same second with a different value is stored as a conflict.
 * - **Truth.** A webhook is a hint and the provider's list is the truth: every
 *   accepted event asks for a sync soon after, which settles a conflict, an
 *   unknown value and a status whose meaning for sending is unknown.
 * - **Unregistered.** An event for a template with no registry row is stored
 *   and reported, never turned into a row.
 */
@Injectable()
export class TemplateStatusService {
  private readonly logger = new Logger(TemplateStatusService.name);

  constructor(
    private readonly repository: WhatsappTemplateSyncRepository,
    @Inject(TEMPLATE_REGISTRY_PORT)
    private readonly registry: TemplateRegistryPort,
    private readonly alerts: TemplateAlertService,
    private readonly producer: WhatsappTemplateSyncProducer,
  ) {}

  async applyEvents(
    events: readonly TemplateProviderEvent[],
  ): Promise<TemplateEventsSummary> {
    const summary: TemplateEventsSummary = {
      applied: 0,
      stale: 0,
      conflict: 0,
      unregistered: 0,
      duplicate: 0,
    };
    const transitions: TemplateTransition[] = [];
    for (const event of events) {
      const result = await this.repository.recordEvent(event, (rows) => {
        const decisions = rows.map((row) => ({
          row,
          ...decideEvent(row, event),
        }));
        return {
          outcome: decisions[0].outcome,
          updates: decisions
            .filter((decision) => decision.outcome === 'applied')
            .map((decision) => ({ id: decision.row.id, next: decision.next })),
        };
      });
      if (result.duplicate) {
        summary.duplicate += 1;
        continue;
      }
      summary[result.outcome] += 1;
      for (const update of result.updates) {
        const row = result.before.find(
          (candidate) => candidate.id === update.id,
        );
        if (row) {
          transitions.push({
            row,
            before: providerState(row),
            after: update.next,
            drift: false,
          });
        }
      }
      if (result.outcome === 'unregistered' || result.outcome === 'conflict') {
        this.logger.warn(
          buildBackendLog(TemplateStatusService.name, {
            action: 'whatsapp-template-event',
            outcome: 'skipped',
            reason: result.outcome,
            field: event.field,
            templateName: event.templateName,
            languageCode: event.languageCode,
          }),
        );
      }
    }

    if (summary.applied > 0) this.registry.invalidate();
    await this.alerts.evaluate(transitions);
    if (events.length > summary.duplicate) {
      await this.producer.requestSyncSoon();
    }
    this.logger.log(
      buildBackendLog(TemplateStatusService.name, {
        action: 'whatsapp-template-events',
        outcome: 'success',
        ...summary,
      }),
    );
    return summary;
  }
}
