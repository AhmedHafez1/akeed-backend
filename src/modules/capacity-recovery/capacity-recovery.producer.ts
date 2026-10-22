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
  capacityRecoveryDedupeId,
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

  async request(
    orgId: string,
    trigger: CapacityRecoveryTrigger,
  ): Promise<void> {
    if (!readUsageAlertsConfig(this.config).recoveryEnabled) return;
    try {
      // While a run for the org is waiting, another request joins it. A run
      // already in progress re-reads capacity for every order it sends, and
      // the sweep catches anything granted after it ends.
      await this.queue.add(
        CAPACITY_RECOVERY_RECOVER_JOB,
        { orgId, trigger },
        {
          ...DEFAULT_QUEUE_JOB_OPTIONS,
          deduplication: { id: capacityRecoveryDedupeId(orgId) },
        },
      );
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
