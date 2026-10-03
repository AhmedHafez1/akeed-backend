import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CommerceOutcomeSyncsRepository } from '../../infrastructure/database/repositories/commerce-outcome-syncs.repository';
import type { CommerceOutcomeAction } from '../../shared/commerce/commerce-outcome';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { CommerceOutcomeRegistryService } from './commerce-outcome-registry.service';
import {
  COMMERCE_OUTCOME_SYNC_QUEUE_NAME,
  type CommerceOutcomeSyncJobPayload,
} from './commerce-outcome-sync.constants';

/**
 * Tries a waiting outcome again, through the same registry and adapter as the
 * first time. The registry records the result and schedules the next try, so
 * this only decides whether the row still wants one.
 */
@Processor(COMMERCE_OUTCOME_SYNC_QUEUE_NAME, { concurrency: 5 })
@Injectable()
export class CommerceOutcomeSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(CommerceOutcomeSyncProcessor.name);

  constructor(
    private readonly syncs: CommerceOutcomeSyncsRepository,
    private readonly registry: CommerceOutcomeRegistryService,
  ) {
    super();
  }

  async process(job: Job<CommerceOutcomeSyncJobPayload>): Promise<void> {
    const { syncId, orgId } = job.data;
    const sync = await this.syncs.findByIdForOrg(syncId, orgId);
    if (!sync || sync.state !== 'pending') {
      this.logger.log(
        buildBackendLog(CommerceOutcomeSyncProcessor.name, {
          action: 'commerce-outcome-sync-retry',
          outcome: 'skipped',
          jobId: String(job.id),
          orgId,
          syncId,
          reason: sync ? `state_${sync.state}` : 'sync_not_found',
        }),
      );
      return;
    }

    const result = await this.registry.dispatch({
      orgId: sync.orgId,
      integrationId: sync.integrationId,
      externalOrderId: sync.externalOrderId,
      action: sync.action as CommerceOutcomeAction,
      correlationId: sync.correlationId,
      retryInBackground: sync.retryInBackground,
    });
    // A dispatch refused before the adapter ran (the order or its source is
    // no longer what the row names) records nothing, so the row is closed
    // here instead of waiting forever.
    if (result.status === 'permanent_failure')
      await this.syncs.failPending(sync.id, sync.orgId, result.errorCode);

    this.logger.log(
      buildBackendLog(CommerceOutcomeSyncProcessor.name, {
        action: 'commerce-outcome-sync-retry',
        outcome:
          result.status === 'applied' ||
          result.status === 'accepted_without_reference'
            ? 'success'
            : result.status === 'retryable_failure'
              ? 'retry'
              : 'failure',
        jobId: String(job.id),
        orgId,
        syncId,
        integrationId: sync.integrationId,
        commerceAction: sync.action,
        synchronizationState: result.status,
      }),
    );
  }
}
