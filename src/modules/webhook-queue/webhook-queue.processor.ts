import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { WebhookJobPayload } from './interfaces/webhook-job.interface';
import {
  WEBHOOK_ORDER_NORMALIZERS,
  WebhookOrderNormalizer,
} from './interfaces/webhook-normalizer.interface';
import { WebhookEventsRepository } from '../../infrastructure/database/repositories/webhook-events.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import {
  WEBHOOK_QUEUE_NAME,
  PlatformType,
  WebhookJobType,
} from './webhook-queue.constants';

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

  constructor(
    @Inject(WEBHOOK_ORDER_NORMALIZERS)
    normalizers: WebhookOrderNormalizer[],
    private readonly webhookEventsRepo: WebhookEventsRepository,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly verificationHub: VerificationHubService,
  ) {
    super();
    this.normalizersByPlatform = new Map(
      normalizers.map((n) => [n.platform, n]),
    );
    this.logger.log(
      `Registered normalizers for: ${[...this.normalizersByPlatform.keys()].join(', ')}`,
    );
  }

  async process(job: Job<WebhookJobPayload>): Promise<void> {
    const { data } = job;
    this.logger.log(
      `Processing job ${job.id} — type=${data.jobType} platform=${data.platform} store=${data.storeDomain}`,
    );

    await this.webhookEventsRepo.markProcessing(data.webhookEventId);

    switch (data.jobType) {
      case WebhookJobType.ORDER_CREATE:
        if (await this.handleOrderCreate(data)) {
          await this.webhookEventsRepo.markCompleted(data.webhookEventId);
        }
        break;
      default:
        this.logger.warn(`Unhandled job type: ${data.jobType} — skipping`);
        await this.webhookEventsRepo.markSkipped(
          data.webhookEventId,
          `unhandled_job_type:${data.jobType}`,
        );
        return;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<WebhookJobPayload> | undefined, error: Error) {
    if (!job) {
      this.logger.error(
        `Webhook queue job failed without job context: ${error.message}`,
      );
      return;
    }

    const maxAttempts =
      typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
    if (job.attemptsMade < maxAttempts) return;

    await this.webhookEventsRepo.markFailed(
      job.data.webhookEventId,
      error.message,
      job.attemptsMade,
    );
  }

  private async handleOrderCreate(data: WebhookJobPayload): Promise<boolean> {
    const integration = await this.integrationsRepo.findByPlatformDomain(
      data.storeDomain,
      data.platform,
    );

    if (!integration?.orgId) {
      this.logger.warn(
        `No integration found for ${data.platform}:${data.storeDomain} — skipping`,
      );
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        'no_integration_found',
      );
      return false;
    }

    if (this.isIntegrationBillingBlocked(integration)) {
      this.logger.warn(
        `Billing blocked for ${data.platform}:${data.storeDomain} (status=${integration.billingStatus ?? 'unknown'}) — skipping`,
      );
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        `billing_blocked:${integration.billingStatus ?? 'unknown'}`,
      );
      return false;
    }

    const normalizer = this.normalizersByPlatform.get(data.platform);
    if (!normalizer) {
      this.logger.error(
        `No normalizer registered for platform "${data.platform}"`,
      );
      await this.webhookEventsRepo.markSkipped(
        data.webhookEventId,
        `no_normalizer:${data.platform}`,
      );
      return false;
    }

    const normalizedOrder = normalizer.normalizeOrder(
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

    await this.verificationHub.handleNewOrder(normalizedOrder, integration);
    return true;
  }

  private isIntegrationBillingBlocked(
    integration: NonNullable<
      Awaited<ReturnType<IntegrationsRepository['findByPlatformDomain']>>
    >,
  ): boolean {
    if (integration.isActive === false) return true;

    const status = integration.billingStatus?.trim().toLowerCase();
    if (!status) return true;

    return !['active', 'not_required'].includes(status);
  }
}
