import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { readWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import {
  WHATSAPP_TEMPLATE_SYNC_EVERY_MS,
  WHATSAPP_TEMPLATE_SYNC_JOB,
  WHATSAPP_TEMPLATE_SYNC_QUEUE,
  WHATSAPP_TEMPLATE_SYNC_SCHEDULER,
  WHATSAPP_TEMPLATE_SYNC_WEBHOOK_DELAY_MS,
  WHATSAPP_TEMPLATE_SYNC_WEBHOOK_JOB_ID,
  type WhatsappTemplateSyncJob,
} from './whatsapp-template-sync-queue.constants';

/** A sync is not retried by the queue: the next run is the retry (4.9.5). */
const SYNC_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
};

/**
 * Schedules the template sync. With sync enabled, a repeatable job runs it
 * every 6 hours; with it off, any schedule left by an earlier release is
 * removed. A template webhook asks for one more sync a minute later, and a
 * burst of webhooks shares that one job.
 */
@Injectable()
export class WhatsappTemplateSyncProducer implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhatsappTemplateSyncProducer.name);

  constructor(
    @InjectQueue(WHATSAPP_TEMPLATE_SYNC_QUEUE)
    private readonly queue: Queue<WhatsappTemplateSyncJob>,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.schedule();
  }

  async schedule(): Promise<void> {
    try {
      if (readWhatsappTemplateConfig(this.config).syncEnabled) {
        await this.queue.upsertJobScheduler(
          WHATSAPP_TEMPLATE_SYNC_SCHEDULER,
          { every: WHATSAPP_TEMPLATE_SYNC_EVERY_MS },
          {
            name: WHATSAPP_TEMPLATE_SYNC_JOB,
            data: { trigger: 'scheduled' },
            opts: SYNC_JOB_OPTIONS,
          },
        );
      } else {
        await this.queue.removeJobScheduler(WHATSAPP_TEMPLATE_SYNC_SCHEDULER);
      }
    } catch (error) {
      this.logger.error(
        buildBackendLog(WhatsappTemplateSyncProducer.name, {
          action: 'whatsapp-template-sync-schedule',
          outcome: 'failure',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode: 'queue_unavailable',
        }),
      );
    }
  }

  /** Never throws: a webhook is answered whatever the queue does. */
  async requestSyncSoon(): Promise<void> {
    if (!readWhatsappTemplateConfig(this.config).syncEnabled) return;
    try {
      await this.queue.add(
        WHATSAPP_TEMPLATE_SYNC_JOB,
        { trigger: 'webhook' },
        {
          ...SYNC_JOB_OPTIONS,
          jobId: WHATSAPP_TEMPLATE_SYNC_WEBHOOK_JOB_ID,
          delay: WHATSAPP_TEMPLATE_SYNC_WEBHOOK_DELAY_MS,
        },
      );
    } catch (error) {
      this.logger.warn(
        buildBackendLog(WhatsappTemplateSyncProducer.name, {
          action: 'whatsapp-template-sync-request',
          outcome: 'failure',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode: 'queue_unavailable',
        }),
      );
    }
  }
}
