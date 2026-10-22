import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JobsOptions, Queue } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import {
  CAPACITY_RECOVERY_QUEUE,
  CAPACITY_RECOVERY_SWEEP_EVERY_MS,
  CAPACITY_RECOVERY_SWEEP_JOB,
  CAPACITY_RECOVERY_SWEEP_SCHEDULER,
} from './capacity-recovery.constants';

/** A sweep is not retried: the next one is ten minutes away. */
const SWEEP_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 60 * 60, count: 200 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
};

/** Owns the repeating sweep; switching recovery off removes it. */
@Injectable()
export class CapacityRecoveryScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CapacityRecoveryScheduler.name);

  constructor(
    @InjectQueue(CAPACITY_RECOVERY_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.ensure();
  }

  async ensure(): Promise<void> {
    const enabled = readUsageAlertsConfig(this.config).recoveryEnabled;
    try {
      if (enabled) {
        await this.queue.upsertJobScheduler(
          CAPACITY_RECOVERY_SWEEP_SCHEDULER,
          { every: CAPACITY_RECOVERY_SWEEP_EVERY_MS },
          {
            name: CAPACITY_RECOVERY_SWEEP_JOB,
            data: {},
            opts: SWEEP_JOB_OPTIONS,
          },
        );
      } else {
        await this.queue.removeJobScheduler(CAPACITY_RECOVERY_SWEEP_SCHEDULER);
      }
      this.logger.log(
        buildBackendLog(CapacityRecoveryScheduler.name, {
          action: 'capacity-recovery-scheduler-ensure',
          outcome: 'success',
          enabled,
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(CapacityRecoveryScheduler.name, {
          action: 'capacity-recovery-scheduler-ensure',
          outcome: 'failure',
          errorCode: 'queue_unavailable',
          ...normalizeError(error),
        }),
      );
    }
  }
}
