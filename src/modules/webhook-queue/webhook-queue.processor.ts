import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { WebhookJobPayload } from './interfaces/webhook-job.interface';
import {
  WEBHOOK_ORDER_NORMALIZERS,
  WebhookOrderNormalizer,
} from './interfaces/webhook-normalizer.interface';
import { WebhookEventsRepository } from '../../infrastructure/database/repositories/webhook-events.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import { WEBHOOK_QUEUE_NAME, WebhookJobType } from './webhook-queue.constants';
import type { PlatformType } from '../../shared/interfaces/commerce-source.interface';
import { isPlatformType } from '../../shared/interfaces/commerce-source.interface';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { RetryAfterError } from '../../shared/http/bounded-http';
import {
  WEBHOOK_ORDER_UPDATE_HANDLERS,
  type WebhookOrderUpdateHandler,
} from './interfaces/webhook-order-update-handler.interface';

/**
 * A job that keeps being told "later" is rescheduled this many times without
 * spending an attempt; after that it fails and retries like any other error.
 */
export const WEBHOOK_JOB_MAX_DEFERRALS = 5;
const WEBHOOK_JOB_MAX_DEFERRAL_MS = 5 * 60_000;

/**
 * BullMQ consumer that processes webhook jobs.
 *
 * Responsibilities:
 *  1. Look up the integration for the store domain.
 *  2. Delegate to the correct platform normalizer.
 *  3. Run the core business logic (VerificationHubService).
 *  4. Update the webhook_events row with the outcome.
 *
 * Retry semantics are handled by BullMQ (exponential backoff, 5 attempts).
 * After all retries are exhausted the `failed` handler persists the error.
 * A normalizer that throws `RetryAfterError` is rescheduled for the delay it
 * names instead: the backoff is shorter than a provider's rate window.
 */
@Processor(WEBHOOK_QUEUE_NAME, {
  concurrency: 10,
})
@Injectable()
export class WebhookQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookQueueProcessor.name);
  private readonly normalizersByPlatform: Map<
    PlatformType,
    WebhookOrderNormalizer
  >;
  private readonly updateHandlersByPlatform: Map<
    PlatformType,
    WebhookOrderUpdateHandler
  >;

  constructor(
    @Inject(WEBHOOK_ORDER_NORMALIZERS)
    normalizers: WebhookOrderNormalizer[],
    private readonly webhookEventsRepo: WebhookEventsRepository,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly verificationHub: VerificationHubService,
    @Optional()
    @Inject(WEBHOOK_ORDER_UPDATE_HANDLERS)
    updateHandlers: WebhookOrderUpdateHandler[] = [],
  ) {
    super();
    this.updateHandlersByPlatform = new Map(
      updateHandlers.map((handler) => [handler.platform, handler]),
    );
    this.normalizersByPlatform = new Map(
      normalizers.map((n) => [n.platform, n]),
    );
    this.logger.log(
      buildBackendLog(WebhookQueueProcessor.name, {
        action: 'webhook-queue-normalizers-register',
        outcome: 'success',
        normalizers: [...this.normalizersByPlatform.keys()],
      }),
    );
  }

  async process(job: Job<WebhookJobPayload>, token?: string): Promise<void> {
    try {
      await this.handle(job);
    } catch (error) {
      if (
        error instanceof RetryAfterError &&
        (await this.defer(job, token, error))
      )
        throw new DelayedError();
      throw error;
    }
  }

  /**
   * Releases the event and moves the job to the delayed set. Answers false
   * when the job cannot be rescheduled, so the caller fails it normally.
   */
  private async defer(
    job: Job<WebhookJobPayload>,
    token: string | undefined,
    error: RetryAfterError,
  ): Promise<boolean> {
    const deferrals = job.data.deferrals ?? 0;
    if (!token || deferrals >= WEBHOOK_JOB_MAX_DEFERRALS) return false;
    const delayMs = Math.min(
      Math.max(Math.ceil(error.delayMs), 0),
      WEBHOOK_JOB_MAX_DEFERRAL_MS,
    );
    await this.webhookEventsRepo.markProcessingRetryable(
      job.data.webhookEventId,
      error.message,
      job.attemptsMade,
    );
    await job.updateData({ ...job.data, deferrals: deferrals + 1 });
    await job.moveToDelayed(Date.now() + delayMs, token);
    this.logger.warn(
      buildBackendLog(WebhookQueueProcessor.name, {
        action: 'webhook-job-defer',
        outcome: 'skipped',
        jobId: String(job.id),
        webhookEventId: job.data.webhookEventId,
        platform: job.data.platform,
        reason: error.message,
        delayMs,
        deferrals: deferrals + 1,
      }),
    );
    return true;
  }

  private async handle(job: Job<WebhookJobPayload>): Promise<void> {
    const { data } = job;
    const claim = await this.webhookEventsRepo.claimForProcessing(
      data.webhookEventId,
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    if (claim !== 'claimed') {
      this.logger.warn(
        buildBackendLog(WebhookQueueProcessor.name, {
          action: 'webhook-job-claim',
          outcome: 'skipped',
          jobId: String(job.id),
          webhookEventId: data.webhookEventId,
          reason: claim,
        }),
      );
      return;
    }

    this.logger.log(
      buildBackendLog(WebhookQueueProcessor.name, {
        action: 'webhook-job-process',
        outcome: 'success',
        jobId: String(job.id),
        webhookEventId: data.webhookEventId,
        platform: data.platform,
        jobType: data.jobType,
        shopDomain: data.storeDomain,
      }),
    );

    if (!isPlatformType(data.platform)) {
      this.logger.warn(
        buildBackendLog(WebhookQueueProcessor.name, {
          action: 'webhook-job-process',
          outcome: 'skipped',
          jobId: String(job.id),
          webhookEventId: data.webhookEventId,
          platform: String(data.platform),
          reason: 'unsupported_platform',
        }),
      );
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        `unsupported_platform:${String(data.platform)}`,
      );
      return;
    }

    switch (data.jobType) {
      case WebhookJobType.ORDER_CREATE:
        if (await this.handleOrderCreate(data)) {
          await this.webhookEventsRepo.markCompleted(data.webhookEventId);
        }
        break;
      case WebhookJobType.ORDER_UPDATE:
        await this.handleOrderUpdate(job);
        break;
      default:
        await this.skipUnhandled(job);
        return;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<WebhookJobPayload> | undefined, error: Error) {
    if (!job) {
      this.logger.error(
        buildBackendLog(WebhookQueueProcessor.name, {
          action: 'webhook-job-process',
          outcome: 'failure',
          reason: 'missing_job_context',
          ...normalizeError(error),
        }),
      );
      return;
    }

    const maxAttempts =
      typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
    if (job.attemptsMade < maxAttempts) {
      await this.webhookEventsRepo.markProcessingRetryable(
        job.data.webhookEventId,
        error.message,
        job.attemptsMade,
      );
      return;
    }

    await this.webhookEventsRepo.markFailed(
      job.data.webhookEventId,
      error.message,
      job.attemptsMade,
    );
  }

  /**
   * The active source the event was accepted for, or null once the event has
   * been marked skipped with the reason.
   */
  private async resolveSource(
    data: WebhookJobPayload,
    action: string,
  ): Promise<Awaited<
    ReturnType<IntegrationsRepository['findBySourceIdentity']>
  > | null> {
    if (!data.integrationId || !data.orgId) {
      this.logger.warn(
        buildBackendLog(WebhookQueueProcessor.name, {
          action,
          outcome: 'skipped',
          webhookEventId: data.webhookEventId,
          platform: data.platform,
          shopDomain: data.storeDomain,
          reason: 'missing_source_identity',
        }),
      );
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        'missing_source_identity',
      );
      return null;
    }

    const integration = await this.integrationsRepo.findBySourceIdentity({
      id: data.integrationId,
      orgId: data.orgId,
      platformType: data.platform,
      platformStoreUrl: data.storeDomain,
    });

    if (!integration) {
      this.logger.warn(
        buildBackendLog(WebhookQueueProcessor.name, {
          action,
          outcome: 'skipped',
          webhookEventId: data.webhookEventId,
          platform: data.platform,
          shopDomain: data.storeDomain,
          orgId: data.orgId,
          integrationId: data.integrationId,
          reason: 'source_identity_mismatch',
        }),
      );
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        'source_identity_mismatch',
      );
      return null;
    }

    if (integration.isActive !== true) {
      this.logger.warn(
        buildBackendLog(WebhookQueueProcessor.name, {
          action,
          outcome: 'skipped',
          webhookEventId: data.webhookEventId,
          platform: data.platform,
          shopDomain: data.storeDomain,
          orgId: data.orgId,
          integrationId: data.integrationId,
          reason: 'integration_inactive',
        }),
      );
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        'integration_inactive',
      );
      return null;
    }

    return integration ?? null;
  }

  /**
   * Hands a status change to its platform's handler. A platform without one
   * keeps the event unhandled, exactly as before handlers existed.
   */
  private async handleOrderUpdate(job: Job<WebhookJobPayload>): Promise<void> {
    const { data } = job;
    const handler = this.updateHandlersByPlatform.get(data.platform);
    if (!handler) return this.skipUnhandled(job);

    const integration = await this.resolveSource(
      data,
      'webhook-order-update-handle',
    );
    if (!integration) return;

    const result = await handler.handleOrderUpdate(
      data.rawPayload,
      integration.id,
      integration.orgId,
    );
    if ('skipped' in result) {
      this.logger.log(
        buildBackendLog(WebhookQueueProcessor.name, {
          action: 'webhook-order-update-handle',
          outcome: 'skipped',
          webhookEventId: data.webhookEventId,
          platform: data.platform,
          orgId: integration.orgId,
          integrationId: integration.id,
          reason: result.reason,
        }),
      );
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        result.reason,
      );
      return;
    }
    await this.webhookEventsRepo.markCompleted(data.webhookEventId);
  }

  private async skipUnhandled(job: Job<WebhookJobPayload>): Promise<void> {
    const { data } = job;
    this.logger.warn(
      buildBackendLog(WebhookQueueProcessor.name, {
        action: 'webhook-job-process',
        outcome: 'skipped',
        jobId: String(job.id),
        webhookEventId: data.webhookEventId,
        platform: data.platform,
        jobType: data.jobType,
        shopDomain: data.storeDomain,
        reason: 'unhandled_job_type',
      }),
    );
    await this.webhookEventsRepo.markSkipped(
      data.webhookEventId,
      `unhandled_job_type:${data.jobType}`,
    );
  }

  private async handleOrderCreate(data: WebhookJobPayload): Promise<boolean> {
    const integration = await this.resolveSource(
      data,
      'webhook-order-create-handle',
    );
    if (!integration) return false;

    const normalizer = this.normalizersByPlatform.get(data.platform);
    if (!normalizer) {
      this.logger.error(
        buildBackendLog(WebhookQueueProcessor.name, {
          action: 'webhook-order-create-handle',
          outcome: 'failure',
          webhookEventId: data.webhookEventId,
          platform: data.platform,
          shopDomain: data.storeDomain,
          reason: 'no_normalizer_registered',
        }),
      );
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        `no_normalizer:${data.platform}`,
      );
      return false;
    }

    const normalizedOrder = await normalizer.normalizeOrder(
      data.rawPayload,
      integration.id,
      integration.orgId,
    );

    if (!normalizedOrder) {
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        'normalisation_failed',
      );
      return false;
    }

    if ('skipped' in normalizedOrder) {
      this.logger.warn(
        buildBackendLog(WebhookQueueProcessor.name, {
          action: 'webhook-order-create-handle',
          outcome: 'skipped',
          webhookEventId: data.webhookEventId,
          platform: data.platform,
          orgId: integration.orgId,
          integrationId: integration.id,
          reason: normalizedOrder.reason,
        }),
      );
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        normalizedOrder.reason,
      );
      return false;
    }

    const result = await this.verificationHub.handleNewOrder(
      normalizedOrder,
      integration,
    );

    // Attach the event to its order so the merchant-facing lifecycle and retry
    // work the same way for every platform. Manual ingestion links at accept
    // time; a webhook only learns its order id here.
    if (result.orderId) {
      try {
        await this.webhookEventsRepo.linkOrder(
          data.webhookEventId,
          result.orderId,
        );
      } catch (error) {
        // The link only powers merchant retry and the lifecycle projection.
        // Losing it must never fail an order that verified successfully.
        this.logger.warn(
          buildBackendLog(WebhookQueueProcessor.name, {
            action: 'webhook-event-order-link',
            outcome: 'failure',
            webhookEventId: data.webhookEventId,
            orderId: result.orderId,
            ...normalizeError(error),
          }),
        );
      }
    }

    if ('skipped' in result) {
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        result.reason,
      );
      return false;
    }
    return true;
  }
}
