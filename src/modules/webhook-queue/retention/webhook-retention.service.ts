import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  WebhookEventsRetentionRepository,
  type WebhookRetentionResult,
} from '../../../infrastructure/database/repositories/webhook-events-retention.repository';
import { OrderIntakeRepository } from '../../../infrastructure/database/repositories/order-intake.repository';
import { ORDER_INTAKE_RETENTION_MS } from '../../../shared/commerce/order-intake.policy';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';

/**
 * Removes webhook rows no reader needs after the 48h resend window, so
 * unlinked finished rows (full order payloads) never pile up again. The rules
 * are `WebhookRetentionRules`; this only runs them and logs counts. The same
 * run deletes admin order intake counts older than 90 days.
 */
@Injectable()
export class WebhookRetentionService {
  private readonly logger = new Logger(WebhookRetentionService.name);

  constructor(
    private readonly retention: WebhookEventsRetentionRepository,
    @Optional() private readonly orderIntake?: OrderIntakeRepository,
  ) {}

  async run(now = new Date()): Promise<WebhookRetentionResult> {
    const started = Date.now();
    const result = await this.retention.run({ now });
    const intake = this.orderIntake
      ? await this.orderIntake.deleteOlderThan(
          new Date(now.getTime() - ORDER_INTAKE_RETENTION_MS),
        )
      : null;
    this.logger.log(
      buildBackendLog(WebhookRetentionService.name, {
        action: 'webhook-events-retention',
        outcome: 'success',
        deletedUnlinkedFinished: result.deleted.unlinked_finished,
        deletedNoStore: result.deleted.no_store,
        deletedBeforeUninstall: result.deleted.before_uninstall,
        scrubbedWooCommerceMarkers: result.scrubbed,
        deletedIntakeOrders: intake?.orders ?? 0,
        deletedIntakeBuckets: intake?.buckets ?? 0,
        truncated: result.truncated || Boolean(intake?.truncated),
        durationMs: Date.now() - started,
      }),
    );
    return result;
  }
}
