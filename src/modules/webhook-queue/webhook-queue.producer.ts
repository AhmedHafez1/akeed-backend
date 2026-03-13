import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  WebhookEventsRepository,
  WebhookEvent,
} from '../../infrastructure/database/repositories/webhook-events.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import {
  WEBHOOK_QUEUE_NAME,
  PlatformType,
  WebhookJobType,
} from './webhook-queue.constants';
import { WebhookJobPayload } from './interfaces/webhook-job.interface';

export interface WebhookIngestionParams {
  platform: PlatformType;
  jobType: WebhookJobType;
  idempotencyKey: string;
  storeDomain: string;
  rawPayload: Record<string, unknown>;
}

/**
 * Thin producer: persists the event and enqueues a BullMQ job.
 *
 * Called by each platform's webhook controller to decouple the HTTP 200 ACK
 * from the (potentially slow) business-logic processing.
 */
@Injectable()
export class WebhookQueueProducer {
  private readonly logger = new Logger(WebhookQueueProducer.name);

  constructor(
    @InjectQueue(WEBHOOK_QUEUE_NAME) private readonly queue: Queue,
    private readonly webhookEventsRepo: WebhookEventsRepository,
    private readonly integrationsRepo: IntegrationsRepository,
  ) {}

  /**
   * Persist + enqueue a webhook event.
   *
   * @returns `{ enqueued: true }` on success, `{ enqueued: false, duplicate: true }` if
   *          the idempotency key already exists.
   */
  async ingest(
    params: WebhookIngestionParams,
  ): Promise<{ enqueued: boolean; duplicate?: boolean }> {
    const integration = await this.integrationsRepo.findByPlatformDomain(
      params.storeDomain,
      params.platform,
    );

    const event: WebhookEvent | null = await this.webhookEventsRepo.insertIfNew(
      {
        platform: params.platform,
        jobType: params.jobType,
        idempotencyKey: params.idempotencyKey,
        storeDomain: params.storeDomain,
        orgId: integration?.orgId ?? null,
        integrationId: integration?.id ?? null,
        rawPayload: params.rawPayload,
      },
    );

    if (!event) {
      this.logger.warn(
        `Duplicate webhook ignored: platform=${params.platform} key=${params.idempotencyKey}`,
      );
      return { enqueued: false, duplicate: true };
    }

    const jobPayload: WebhookJobPayload = {
      webhookEventId: event.id,
      platform: params.platform,
      jobType: params.jobType,
      idempotencyKey: params.idempotencyKey,
      storeDomain: params.storeDomain,
      rawPayload: params.rawPayload,
      receivedAt: event.receivedAt ?? new Date().toISOString(),
    };

    await this.queue.add(params.jobType, jobPayload, {
      jobId: `${params.platform}:${params.idempotencyKey}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 3_000 },
      removeOnComplete: { age: 7 * 24 * 3_600, count: 10_000 },
      removeOnFail: { age: 30 * 24 * 3_600, count: 50_000 },
    });

    this.logger.log(
      `Enqueued ${params.jobType} job for ${params.platform}:${params.storeDomain} (eventId=${event.id})`,
    );

    return { enqueued: true };
  }
}
