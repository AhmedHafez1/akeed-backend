import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import {
  AUTO_CANCELLATION_CONFIRM_JOB,
  AUTO_CANCELLATION_EXECUTE_JOB,
  AUTO_CANCELLATION_QUEUE,
  AUTO_CANCELLATION_SWEEP_JOB,
  type AutoCancellationJobPayload,
} from './auto-cancellation.constants';
import { AutoCancellationService } from './auto-cancellation.service';

/**
 * The worker on the `auto-cancellation` queue. A job that throws is retried
 * by BullMQ; that is safe because every step claims or re-checks its row
 * under a lock before it acts.
 */
@Processor(AUTO_CANCELLATION_QUEUE, { concurrency: 5 })
@Injectable()
export class AutoCancellationProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoCancellationProcessor.name);

  constructor(private readonly autoCancellation: AutoCancellationService) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case AUTO_CANCELLATION_EXECUTE_JOB:
        await this.autoCancellation.execute(
          (job.data as AutoCancellationJobPayload).autoCancellationId,
        );
        return;
      case AUTO_CANCELLATION_CONFIRM_JOB:
        await this.autoCancellation.confirm(
          (job.data as AutoCancellationJobPayload).autoCancellationId,
        );
        return;
      case AUTO_CANCELLATION_SWEEP_JOB:
        await this.autoCancellation.sweep();
        return;
      default:
        this.logger.warn(
          buildBackendLog(AutoCancellationProcessor.name, {
            action: 'auto-cancellation-job',
            outcome: 'skipped',
            jobId: String(job.id),
            jobType: job.name,
            reason: 'unknown_job',
          }),
        );
    }
  }
}
