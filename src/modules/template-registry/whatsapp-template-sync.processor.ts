import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  WHATSAPP_TEMPLATE_SYNC_QUEUE,
  type WhatsappTemplateSyncJob,
} from './whatsapp-template-sync-queue.constants';
import { WhatsappTemplateSyncService } from './whatsapp-template-sync.service';

@Processor(WHATSAPP_TEMPLATE_SYNC_QUEUE, { concurrency: 1 })
@Injectable()
export class WhatsappTemplateSyncProcessor extends WorkerHost {
  constructor(private readonly sync: WhatsappTemplateSyncService) {
    super();
  }

  async process(job: Job<WhatsappTemplateSyncJob>): Promise<void> {
    await this.sync.runSync(job.data.trigger ?? 'scheduled');
  }
}
