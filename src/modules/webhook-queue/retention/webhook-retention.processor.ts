import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import {
  WEBHOOK_RETENTION_JOB,
  WEBHOOK_RETENTION_QUEUE,
} from './webhook-retention.constants';
import { WebhookRetentionService } from './webhook-retention.service';

@Processor(WEBHOOK_RETENTION_QUEUE, { concurrency: 1 })
@Injectable()
export class WebhookRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookRetentionProcessor.name);

  constructor(private readonly retention: WebhookRetentionService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === WEBHOOK_RETENTION_JOB) {
      await this.retention.run();
      return;
    }
    this.logger.warn(
      buildBackendLog(WebhookRetentionProcessor.name, {
        action: 'webhook-retention-job',
        outcome: 'skipped',
        reason: 'unknown_job',
        jobName: job.name,
      }),
    );
  }
}
