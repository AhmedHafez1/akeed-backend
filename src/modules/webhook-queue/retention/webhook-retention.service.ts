import { Injectable, Logger } from '@nestjs/common';
import {
  WebhookEventsRetentionRepository,
  type WebhookRetentionResult,
} from '../../../infrastructure/database/repositories/webhook-events-retention.repository';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';

/**
 * Removes webhook rows no reader needs after the 48h resend window, so
 * unlinked finished rows (full order payloads) never pile up again. The rules
 * are `WebhookRetentionRules`; this only runs them and logs counts.
 */
@Injectable()
export class WebhookRetentionService {
  private readonly logger = new Logger(WebhookRetentionService.name);

  constructor(private readonly retention: WebhookEventsRetentionRepository) {}

  async run(now = new Date()): Promise<WebhookRetentionResult> {
    const started = Date.now();
    const result = await this.retention.run({ now });
    this.logger.log(
      buildBackendLog(WebhookRetentionService.name, {
        action: 'webhook-events-retention',
        outcome: 'success',
        deletedUnlinkedFinished: result.deleted.unlinked_finished,
        deletedNoStore: result.deleted.no_store,
        deletedBeforeUninstall: result.deleted.before_uninstall,
        scrubbedWooCommerceMarkers: result.scrubbed,
        truncated: result.truncated,
        durationMs: Date.now() - started,
      }),
    );
    return result;
  }
}
