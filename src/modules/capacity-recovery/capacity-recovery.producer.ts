import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import {
  CAPACITY_RECOVERY_QUEUE,
  CAPACITY_RECOVERY_RECOVER_JOB,
  capacityRecoveryContinuationDedupeId,
  capacityRecoveryDedupeId,
  type CapacityRecoveryCursor,
  type CapacityRecoveryJobPayload,
  type CapacityRecoveryTrigger,
} from './capacity-recovery.constants';

/**
 * Asks for an org's blocked orders to be resumed. Callers call it after their
 * own write has committed and never wait on the result: a lost request is
 * picked up by the sweep, so this never throws.
 */
@Injectable()
export class CapacityRecoveryProducer {
  private readonly logger = new Logger(CapacityRecoveryProducer.name);

  constructor(
    @InjectQueue(CAPACITY_RECOVERY_QUEUE)
    private readonly queue: Queue<CapacityRecoveryJobPayload>,
    private readonly config: ConfigService,
  ) {}

  /**
   * While a run for the org is waiting or running, another request is
   * dropped: a running run re-reads capacity for every order it sends, and
   * the sweep catches anything granted after it ends.
   */
  async request(
    orgId: string,
    trigger: CapacityRecoveryTrigger,
  ): Promise<void> {
    await this.add({ orgId, trigger }, capacityRecoveryDedupeId(orgId));
  }

  /** The next run of a run that ran out of pages, from where it stopped. */
  async continueAfter(
    orgId: string,
    jobId: string,
    after: CapacityRecoveryCursor,
  ): Promise<void> {
    await this.add(
      { orgId, trigger: 'continuation', after },
      capacityRecoveryContinuationDedupeId(orgId, jobId),
    );
  }

  private async add(
    payload: CapacityRecoveryJobPayload,
    deduplicationId: string,
  ): Promise<void> {
    const { orgId, trigger } = payload;
    if (!readUsageAlertsConfig(this.config).recoveryEnabled) return;
    try {
      await this.queue.add(CAPACITY_RECOVERY_RECOVER_JOB, payload, {
        ...DEFAULT_QUEUE_JOB_OPTIONS,
        deduplication: { id: deduplicationId },
      });
    } catch (error) {
      this.logger.warn(
        buildBackendLog(CapacityRecoveryProducer.name, {
          action: 'capacity-recovery-request',
          outcome: 'failure',
          orgId,
          trigger,
          ...normalizeError(error),
        }),
      );
    }
  }
}
