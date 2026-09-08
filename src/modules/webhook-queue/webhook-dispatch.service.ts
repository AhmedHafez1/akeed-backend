import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import {
  WebhookEvent,
  WebhookEventsRepository,
} from '../../infrastructure/database/repositories/webhook-events.repository';
import { isPlatformType } from '../../shared/interfaces/commerce-source.interface';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { WebhookJobPayload } from './interfaces/webhook-job.interface';
import { WEBHOOK_QUEUE_NAME, WebhookJobType } from './webhook-queue.constants';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';

export type DispatchOutcome = 'dispatched' | 'not_claimed' | 'failed';

@Injectable()
export class WebhookDispatchService {
  private readonly logger = new Logger(WebhookDispatchService.name);
  private readonly maxDispatchAttempts: number;
  private readonly dispatchLeaseMs: number;
  private readonly processingStaleMs: number;

  constructor(
    @InjectQueue(WEBHOOK_QUEUE_NAME) private readonly queue: Queue,
    private readonly events: WebhookEventsRepository,
    config: ConfigService,
  ) {
    this.maxDispatchAttempts = this.positiveInteger(
      config.get('WEBHOOK_DISPATCH_MAX_ATTEMPTS'),
      8,
    );
    this.dispatchLeaseMs = this.positiveInteger(
      config.get('WEBHOOK_DISPATCH_LEASE_MS'),
      30_000,
    );
    this.processingStaleMs = this.positiveInteger(
      config.get('WEBHOOK_PROCESSING_STALE_MS'),
      10 * 60_000,
    );
  }

  get retryLimit(): number {
    return this.maxDispatchAttempts;
  }

  get staleBefore(): string {
    return new Date(Date.now() - this.processingStaleMs).toISOString();
  }

  async dispatchById(eventId: string): Promise<DispatchOutcome> {
    const claimed = await this.events.claimForDispatch(
      eventId,
      new Date(Date.now() + this.dispatchLeaseMs).toISOString(),
      this.staleBefore,
      this.maxDispatchAttempts,
    );
    if (!claimed) {
      await this.logNotClaimed(eventId);
      return 'not_claimed';
    }
    return this.dispatchClaimed(claimed);
  }

  private async dispatchClaimed(event: WebhookEvent): Promise<DispatchOutcome> {
    try {
      if (!isPlatformType(event.platform)) {
        throw new Error(`unsupported persisted platform: ${event.platform}`);
      }

      const payload: WebhookJobPayload = {
        webhookEventId: event.id,
        platform: event.platform,
        jobType: event.jobType as WebhookJobType,
        idempotencyKey: event.idempotencyKey,
        storeDomain: event.storeDomain,
        orgId: event.orgId,
        integrationId: event.integrationId,
        rawPayload: event.rawPayload as Record<string, unknown>,
        receivedAt: event.receivedAt ?? new Date().toISOString(),
      };

      await this.queue.add(event.jobType, payload, {
        jobId: this.jobId(event),
        ...DEFAULT_QUEUE_JOB_OPTIONS,
      });
      await this.events.markDispatched(event.id);
      return 'dispatched';
    } catch (error) {
      const message = this.safeErrorMessage(error);
      const terminal = event.dispatchAttempts >= this.maxDispatchAttempts;
      const retryDelayMs = Math.min(
        5 * 60_000,
        3_000 * 2 ** Math.max(0, event.dispatchAttempts - 1),
      );
      try {
        await this.events.markDispatchFailed(
          event.id,
          message,
          terminal,
          terminal ? null : retryDelayMs,
        );
      } catch (recordError) {
        this.logger.error(
          buildBackendLog(WebhookDispatchService.name, {
            action: 'webhook-dispatch-failure-record',
            outcome: 'failure',
            webhookEventId: event.id,
            ...normalizeError(recordError),
          }),
        );
      }
      this.logger.error(
        buildBackendLog(WebhookDispatchService.name, {
          action: 'webhook-dispatch',
          outcome: 'failure',
          webhookEventId: event.id,
          platform: event.platform,
          shopDomain: event.storeDomain,
          dispatchAttempts: event.dispatchAttempts,
          terminal,
          ...normalizeError(error),
        }),
      );
      return 'failed';
    }
  }

  /**
   * `resetForRedispatch` rewinds `dispatchAttempts` to 0, so the next claim
   * lands back on 1 and rebuilds the jobId the first dispatch already used.
   * `removeOnComplete` keeps completed jobs for 7 days and BullMQ treats an
   * `add` with an existing jobId as a no-op, so merchant retry silently
   * enqueued nothing while `markDispatched` still recorded a dispatch.
   *
   * `dispatchLeaseUntil` is written fresh by every successful claim, which
   * makes it the natural per-claim discriminator. Re-processing a duplicate is
   * harmless -- `claimForProcessing` and `createForOrderIfAbsent` are both
   * idempotent -- whereas losing a job is not.
   */
  private jobId(event: WebhookEvent): string {
    const claimToken = event.dispatchLeaseUntil
      ? Date.parse(event.dispatchLeaseUntil)
      : Date.now();
    return `webhook-event-${event.id}-dispatch-${event.dispatchAttempts}-${claimToken}`;
  }

  /**
   * A claim that does not match is the one dispatch outcome that used to
   * produce no output at all, which is how accepted orders disappeared without
   * a single log line. Re-read the row so the reason is in the log rather than
   * inferred from a code trace.
   */
  private async logNotClaimed(eventId: string): Promise<void> {
    let event: WebhookEvent | undefined;
    try {
      event = await this.events.findById(eventId);
    } catch {
      // The diagnostic read must never mask the dispatch outcome.
    }
    this.logger.warn(
      buildBackendLog(WebhookDispatchService.name, {
        action: 'webhook-dispatch',
        outcome: 'skipped',
        reason: 'not_claimed',
        webhookEventId: eventId,
        ...(event
          ? {
              status: event.status,
              dispatchRequired: event.dispatchRequired,
              dispatchAttempts: event.dispatchAttempts,
              dispatchedAt: event.dispatchedAt,
              nextDispatchAt: event.nextDispatchAt,
              dispatchLeaseUntil: event.dispatchLeaseUntil,
              processingLeaseUntil: event.processingLeaseUntil,
            }
          : { detail: 'event_not_found' }),
      }),
    );
  }

  private safeErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : 'unknown error';
    return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
  }

  private positiveInteger(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
