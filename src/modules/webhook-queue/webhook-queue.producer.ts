import { Injectable, Logger } from '@nestjs/common';
import {
  WebhookEventsRepository,
  WebhookEvent,
} from '../../infrastructure/database/repositories/webhook-events.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { WebhookJobType } from './webhook-queue.constants';
import type { PlatformType } from '../../shared/interfaces/commerce-source.interface';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  DispatchOutcome,
  WebhookDispatchService,
} from './webhook-dispatch.service';

interface WebhookIngestionParams {
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
    private readonly webhookEventsRepo: WebhookEventsRepository,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly dispatcher: WebhookDispatchService,
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
        dispatchRequired: true,
      },
    );

    if (!event) {
      let outcome: DispatchOutcome = 'not_claimed';
      try {
        const existing =
          await this.webhookEventsRepo.findBySourceAndIdempotency(
            params.platform,
            params.storeDomain,
            params.idempotencyKey,
          );
        outcome = existing
          ? await this.safeDispatch(existing.id, params)
          : 'not_claimed';
      } catch (error) {
        this.logDeferredDispatch(error, params);
      }
      this.logger.warn(
        buildBackendLog(WebhookQueueProducer.name, {
          action: 'webhook-ingest',
          outcome: 'skipped',
          shopDomain: params.storeDomain,
          platform: params.platform,
          jobType: params.jobType,
          idempotencyKey: params.idempotencyKey,
          reason: 'duplicate_webhook',
        }),
      );
      return { enqueued: outcome === 'dispatched', duplicate: true };
    }
    const outcome = await this.safeDispatch(event.id, params);

    this.logger.log(
      buildBackendLog(WebhookQueueProducer.name, {
        action: 'webhook-ingest',
        outcome: outcome === 'dispatched' ? 'success' : 'failure',
        orgId: integration?.orgId ?? undefined,
        shopDomain: params.storeDomain,
        integrationId: integration?.id ?? undefined,
        platform: params.platform,
        jobType: params.jobType,
        webhookEventId: event.id,
        idempotencyKey: params.idempotencyKey,
      }),
    );

    return { enqueued: outcome === 'dispatched' };
  }

  private async safeDispatch(
    eventId: string,
    params: WebhookIngestionParams,
  ): Promise<DispatchOutcome> {
    try {
      return await this.dispatcher.dispatchById(eventId);
    } catch (error) {
      this.logDeferredDispatch(error, params, eventId);
      return 'failed';
    }
  }

  private logDeferredDispatch(
    error: unknown,
    params: WebhookIngestionParams,
    webhookEventId?: string,
  ): void {
    this.logger.error(
      buildBackendLog(WebhookQueueProducer.name, {
        action: 'webhook-dispatch-deferred',
        outcome: 'failure',
        webhookEventId,
        platform: params.platform,
        shopDomain: params.storeDomain,
        jobType: params.jobType,
        ...normalizeError(error),
      }),
    );
  }
}
