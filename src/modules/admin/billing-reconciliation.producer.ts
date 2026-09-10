import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  readStandaloneBillingObservabilityConfig,
  type StandaloneBillingObservabilityConfig,
} from '../../shared/config/standalone-billing-observability.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';
import {
  BILLING_RECONCILIATION_JOB,
  BILLING_RECONCILIATION_QUEUE,
  BILLING_RECONCILIATION_SCHEDULER,
  type BillingReconciliationJob,
} from './billing-reconciliation-queue.constants';
import { BillingObservabilityRepository } from './billing-observability.repository';
import type {
  BillingRunMode,
  BillingRunTrigger,
} from './billing-observability.types';

@Injectable()
export class BillingReconciliationProducer implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingReconciliationProducer.name);
  private readonly settings: StandaloneBillingObservabilityConfig;

  constructor(
    @InjectQueue(BILLING_RECONCILIATION_QUEUE)
    private readonly queue: Queue<BillingReconciliationJob>,
    private readonly repository: BillingObservabilityRepository,
    config: ConfigService,
  ) {
    this.settings = readStandaloneBillingObservabilityConfig(config);
  }

  onApplicationBootstrap(): void {
    void this.schedule();
  }

  private async schedule(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        BILLING_RECONCILIATION_SCHEDULER,
        {
          pattern: this.settings.cron,
          tz: this.settings.timezone,
        },
        {
          name: BILLING_RECONCILIATION_JOB,
          data: { trigger: 'nightly' },
          opts: DEFAULT_QUEUE_JOB_OPTIONS,
        },
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(BillingReconciliationProducer.name, {
          action: 'billing-reconciliation-schedule',
          outcome: 'failure',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode: 'queue_unavailable',
        }),
      );
    }
  }

  async enqueue(input: {
    trigger: BillingRunTrigger;
    settlementId?: string;
    triggeredBy?: string;
    reason?: string;
    runKey?: string;
  }) {
    const run = await this.repository.createRun({
      runKey: input.runKey ?? `${input.trigger}:${randomUUID()}`,
      trigger: input.trigger,
      mode: this.mode(),
      settlementId: input.settlementId,
      triggeredBy: input.triggeredBy,
      reason: input.reason,
    });
    await this.queue.add(
      BILLING_RECONCILIATION_JOB,
      {
        runId: run.id,
        trigger: input.trigger,
        settlementId: input.settlementId,
      },
      {
        jobId: `billing-reconciliation-${run.id}`,
        ...DEFAULT_QUEUE_JOB_OPTIONS,
      },
    );
    this.logger.log(
      buildBackendLog(BillingReconciliationProducer.name, {
        action: 'billing-reconciliation-enqueue',
        outcome: 'success',
        runId: run.id,
        trigger: input.trigger,
        mode: run.mode,
      }),
    );
    return run;
  }

  mode(): BillingRunMode {
    if (!this.settings.scheduledInquiryEnabled) return 'local_only';
    return this.settings.reportOnly ? 'report_only' : 'active';
  }
}
