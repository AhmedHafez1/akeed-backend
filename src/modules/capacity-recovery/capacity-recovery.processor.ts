import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import {
  CAPACITY_RECOVERY_QUEUE,
  CAPACITY_RECOVERY_RECOVER_JOB,
  CAPACITY_RECOVERY_SWEEP_JOB,
  CAPACITY_RECOVERY_SWEEP_ORGS,
  type CapacityRecoveryJobPayload,
} from './capacity-recovery.constants';
import { CapacityRecoveryProducer } from './capacity-recovery.producer';
import { CapacityRecoveryService } from './capacity-recovery.service';

/**
 * The worker on the `capacity-recovery` queue. A RECOVER job that throws is
 * retried by BullMQ; that is safe because every order is re-checked and
 * claimed again before it is sent.
 */
@Processor(CAPACITY_RECOVERY_QUEUE, { concurrency: 2 })
@Injectable()
export class CapacityRecoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(CapacityRecoveryProcessor.name);

  constructor(
    private readonly recovery: CapacityRecoveryService,
    private readonly producer: CapacityRecoveryProducer,
    private readonly verificationsRepo: VerificationsRepository,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (!readUsageAlertsConfig(this.config).recoveryEnabled) return;
    switch (job.name) {
      case CAPACITY_RECOVERY_SWEEP_JOB:
        await this.sweep();
        return;
      case CAPACITY_RECOVERY_RECOVER_JOB: {
        const { orgId } = job.data as CapacityRecoveryJobPayload;
        const result = await this.recovery.recover(orgId);
        if (result.more) await this.producer.request(orgId, 'continuation');
        return;
      }
      default:
        this.logger.warn(
          buildBackendLog(CapacityRecoveryProcessor.name, {
            action: 'capacity-recovery-job',
            outcome: 'skipped',
            jobId: String(job.id),
            jobType: job.name,
            reason: 'unknown_job',
          }),
        );
    }
  }

  private async sweep(): Promise<void> {
    const orgIds = await this.verificationsRepo.listOrgsWithBlocked(
      CAPACITY_RECOVERY_SWEEP_ORGS,
    );
    for (const orgId of orgIds) await this.producer.request(orgId, 'sweep');
    this.logger.log(
      buildBackendLog(CapacityRecoveryProcessor.name, {
        action: 'capacity-recovery-sweep',
        outcome: 'success',
        organizations: orgIds.length,
      }),
    );
  }
}
