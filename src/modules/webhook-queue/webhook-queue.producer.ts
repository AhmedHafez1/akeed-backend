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
   *          the idempotency key already exists, and `{ enqueued: false }` when
   *          the store has no integration.
   */
  async ingest(
    params: WebhookIngestionParams,
  ): Promise<{ enqueued: boolean; duplicate?: boolean }> {
    const integration = await this.integrationsRepo.findByPlatformDomain(
      params.storeDomain,
      params.platform,
    );

    // The platform keeps delivering for a store whose Akeed rows were deleted
    // while the app stays installed, or whose install never completed. That
    // is expected, so the delivery is acknowledged and dropped: nothing is
    // stored or queued, and it is logged at info level, not as an error.
    if (!integration) {
      this.logger.log(
        buildBackendLog(WebhookQueueProducer.name, {
          action: 'webhook-ingest',
          outcome: 'skipped',
          shopDomain: params.storeDomain,
          platform: params.platform,
          jobType: params.jobType,
          idempotencyKey: params.idempotencyKey,
          reason: 'store_not_connected',
          explanation:
            'The app is still installed on this store, but Akeed has no integration for it (deleted, or onboarding never completed). Order ignored.',
        }),
      );
      return { enqueued: false };
    }

    const event: WebhookEvent | null = await this.webhookEventsRepo.insertIfNew(
      {
        platform: params.platform,
        jobType: params.jobType,
        idempotencyKey: params.idempotencyKey,
        storeDomain: params.storeDomain,
        orgId: integration.orgId,
        integrationId: integration.id,
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
        orgId: integration.orgId,
        shopDomain: params.storeDomain,
        integrationId: integration.id,
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
