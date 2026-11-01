import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import {
  CREDIT_MODEL_NOTICE_QUEUE,
  CREDIT_MODEL_NOTICE_SWEEP_EVERY_MS,
  CREDIT_MODEL_NOTICE_SWEEP_JOB,
  CREDIT_MODEL_NOTICE_SWEEP_SCHEDULER,
} from './credit-model-notice.constants';

/** Owns the repeating email sweep; the switch being off removes it. */
@Injectable()
export class CreditModelNoticeScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CreditModelNoticeScheduler.name);

  constructor(
    @InjectQueue(CREDIT_MODEL_NOTICE_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.ensure();
  }

  async ensure(): Promise<void> {
    const enabled = readUsageAlertsConfig(
      this.config,
    ).creditModelNoticeEmailEnabled;
    try {
      if (enabled) {
        await this.queue.upsertJobScheduler(
          CREDIT_MODEL_NOTICE_SWEEP_SCHEDULER,
          { every: CREDIT_MODEL_NOTICE_SWEEP_EVERY_MS },
          {
            name: CREDIT_MODEL_NOTICE_SWEEP_JOB,
            data: {},
            opts: {
              attempts: 1,
              removeOnComplete: { age: 24 * 60 * 60, count: 200 },
              removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
            },
          },
        );
      } else {
        await this.queue.removeJobScheduler(
          CREDIT_MODEL_NOTICE_SWEEP_SCHEDULER,
        );
      }
    } catch (error) {
      this.logger.error(
        buildBackendLog(CreditModelNoticeScheduler.name, {
          action: 'credit-model-notice-scheduler-ensure',
          outcome: 'failure',
          errorCode: 'queue_unavailable',
          ...normalizeError(error),
        }),
      );
    }
  }
}
