import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import { MetaWebhookEventsService } from './meta-webhook-events.service';
import {
  META_WEBHOOK_PROCESS_JOB,
  META_WEBHOOK_PURGE_JOB,
  META_WEBHOOK_QUEUE,
  META_WEBHOOK_SWEEP_JOB,
  type MetaWebhookJobPayload,
} from './meta-webhook-queue.constants';

/** Runs whichever way the switch is set, so stored events always drain. */
@Processor(META_WEBHOOK_QUEUE, { concurrency: 10 })
@Injectable()
export class MetaWebhookEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(MetaWebhookEventsProcessor.name);

  constructor(private readonly events: MetaWebhookEventsService) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case META_WEBHOOK_PROCESS_JOB:
        await this.events.process((job.data as MetaWebhookJobPayload).eventId);
        return;
      case META_WEBHOOK_SWEEP_JOB:
        await this.events.sweep();
        return;
      case META_WEBHOOK_PURGE_JOB:
        await this.events.purge();
        return;
      default:
        this.logger.warn(
          buildBackendLog(MetaWebhookEventsProcessor.name, {
            action: 'meta-webhook-job',
            outcome: 'skipped',
            reason: 'unknown_job',
            jobName: job.name,
          }),
        );
    }
  }
}
