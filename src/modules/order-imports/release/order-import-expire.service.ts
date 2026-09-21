import { Injectable, Logger } from '@nestjs/common';
import { OrderImportReleaseRepository } from '../../../infrastructure/database/repositories/order-import-release.repository';
import { WebhookEventsRepository } from '../../../infrastructure/database/repositories/webhook-events.repository';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';

/** Batches handled per page; the loop continues while pages come back full. */
const EXPIRE_PAGE = 100;
const MAX_PAGES = 50;

/**
 * The hourly `import.expire` job (AC9): a committed batch the merchant never
 * started, or left paused, past its start window gives its orders up.
 *
 * Holds are withdrawn before the status moves, so a crash in between leaves
 * a batch the next run still selects; start and resume both refuse a batch
 * past its deadline, so neither can race this.
 */
@Injectable()
export class OrderImportExpireService {
  private readonly logger = new Logger(OrderImportExpireService.name);

  constructor(
    private readonly releases: OrderImportReleaseRepository,
    private readonly webhookEvents: WebhookEventsRepository,
  ) {}

  async run(now = new Date()): Promise<{ expired: number; withdrawn: number }> {
    let expired = 0;
    let withdrawn = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batches = await this.releases.listPastStartDeadline(
        now,
        EXPIRE_PAGE,
      );
      for (const batch of batches) {
        const ids = await this.webhookEvents.withdrawHeld(batch.orgId, {
          groupId: batch.id,
        });
        withdrawn += ids.length;
        if (
          await this.releases.markNotStarted({
            orgId: batch.orgId,
            batchId: batch.id,
            now,
          })
        )
          expired += 1;
      }
      if (batches.length < EXPIRE_PAGE) break;
    }
    this.logger.log(
      buildBackendLog(OrderImportExpireService.name, {
        action: 'order-import-expire',
        outcome: 'success',
        expired,
        withdrawn,
      }),
    );
    return { expired, withdrawn };
  }
}
