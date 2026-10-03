import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';
import {
  COMMERCE_OUTCOME_SYNC_JOB,
  COMMERCE_OUTCOME_SYNC_QUEUE_NAME,
  type CommerceOutcomeSyncJobPayload,
} from './commerce-outcome-sync.constants';

export interface OutcomeSyncRetry {
  syncId: string;
  orgId: string;
  /** The row's counters after the try that failed; they make the job id. */
  attempts: number;
  deferrals: number;
  delayMs: number;
}

@Injectable()
export class CommerceOutcomeSyncProducer {
  private readonly logger = new Logger(CommerceOutcomeSyncProducer.name);

  constructor(
    @InjectQueue(COMMERCE_OUTCOME_SYNC_QUEUE_NAME)
    private readonly queue: Queue<CommerceOutcomeSyncJobPayload>,
  ) {}

  /**
   * One job per try: the id is built from the row's counters, so scheduling
   * the same retry twice adds nothing.
   */
  async scheduleRetry(retry: OutcomeSyncRetry): Promise<void> {
    const jobId = `outcome-sync-${retry.syncId}-${retry.attempts}-${retry.deferrals}`;
    await this.queue.add(
      COMMERCE_OUTCOME_SYNC_JOB,
      { syncId: retry.syncId, orgId: retry.orgId },
      { ...DEFAULT_QUEUE_JOB_OPTIONS, jobId, delay: retry.delayMs },
    );
    this.logger.log(
      buildBackendLog(CommerceOutcomeSyncProducer.name, {
        action: 'commerce-outcome-sync-schedule',
        outcome: 'success',
        orgId: retry.orgId,
        syncId: retry.syncId,
        jobId,
        delayMs: retry.delayMs,
      }),
    );
  }
}
