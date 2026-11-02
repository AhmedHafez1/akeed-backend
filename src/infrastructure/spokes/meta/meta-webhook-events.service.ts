import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { Queue, UnrecoverableError } from 'bullmq';
import {
  MetaWebhookEventsRepository,
  type MetaWebhookEvent,
} from '../../database/repositories/meta-webhook-events.repository';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../../shared/queue/job-options';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';
import { MetaTemplateWebhookHandler } from './meta-template-webhook.handler';
import {
  isSingleChange,
  parseBody,
  splitWebhookBody,
} from './meta-webhook-envelope';
import {
  META_WEBHOOK_BACKOFF_MS,
  META_WEBHOOK_ENQUEUE_GRACE_MS,
  META_WEBHOOK_LEASE_MS,
  META_WEBHOOK_MAX_ATTEMPTS,
  META_WEBHOOK_PAYLOAD_RETENTION_DAYS,
  META_WEBHOOK_PROCESS_JOB,
  META_WEBHOOK_QUEUE,
  META_WEBHOOK_RETRY_GRACE_MS,
  META_WEBHOOK_ROW_RETENTION_DAYS,
  META_WEBHOOK_SWEEP_BATCH,
  META_WEBHOOK_SWEEP_MAX_BATCHES,
  META_WEBHOOK_SWEEP_RETRY_MS,
  type MetaWebhookJobPayload,
} from './meta-webhook-queue.constants';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';

const JOB_OPTIONS = {
  attempts: META_WEBHOOK_MAX_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: META_WEBHOOK_BACKOFF_MS },
  removeOnComplete: DEFAULT_QUEUE_JOB_OPTIONS.removeOnComplete,
  removeOnFail: DEFAULT_QUEUE_JOB_OPTIONS.removeOnFail,
};

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

/** A stored event that can never succeed, so it isn't tried again. */
class PermanentEventFailure extends Error {}

/**
 * Stores Meta webhook events, runs them on the queue and cleans up after them.
 *
 * The row is the record. A job is only a nudge to run it, so a lost job, a
 * Redis outage or a crash costs a delay and nothing more: the sweep finds the
 * row and queues it again.
 */
@Injectable()
export class MetaWebhookEventsService {
  private readonly logger = new Logger(MetaWebhookEventsService.name);
  /** The app-wide pipe in `main.ts`, which the worker no longer passes through. */
  private readonly validation = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: false,
  });

  constructor(
    @InjectQueue(META_WEBHOOK_QUEUE) private readonly queue: Queue,
    private readonly events: MetaWebhookEventsRepository,
    private readonly messages: WhatsAppWebhookService,
    private readonly templates: MetaTemplateWebhookHandler,
  ) {}

  /**
   * Stores a signed POST. Throws when it can't, so Meta sends it again. Once
   * stored it is answered 200 whatever Redis does, so queueing isn't waited on.
   */
  async accept(rawBody: Buffer): Promise<void> {
    let rows: { id: string }[];
    try {
      rows = await this.events.insertMany(
        splitWebhookBody(rawBody),
        new Date(Date.now() + META_WEBHOOK_ENQUEUE_GRACE_MS).toISOString(),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(MetaWebhookEventsService.name, {
          action: 'meta-webhook-not-persisted',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
      throw new InternalServerErrorException({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'The webhook could not be stored.',
        code: 'META_WEBHOOK_NOT_PERSISTED',
      });
    }
    if (rows.length === 0) return;
    void this.enqueue(rows.map((row) => ({ id: row.id }))).catch(
      (error: unknown) => this.logEnqueueFailure(rows.length, error),
    );
  }

  private async enqueue(
    rows: readonly { id: string; jobId?: string }[],
  ): Promise<void> {
    await this.queue.addBulk(
      rows.map((row) => ({
        name: META_WEBHOOK_PROCESS_JOB,
        data: { eventId: row.id } satisfies MetaWebhookJobPayload,
        opts: { ...JOB_OPTIONS, jobId: row.jobId ?? `meta-event-${row.id}` },
      })),
    );
  }

  private logEnqueueFailure(eventCount: number, error: unknown): void {
    this.logger.error(
      buildBackendLog(MetaWebhookEventsService.name, {
        action: 'meta-webhook-enqueue',
        outcome: 'failure',
        eventCount,
        ...normalizeError(error),
      }),
    );
  }

  /** One run of one event. Throws for BullMQ to retry. */
  async process(eventId: string): Promise<void> {
    const event = await this.events.claim(
      eventId,
      META_WEBHOOK_LEASE_MS,
      META_WEBHOOK_MAX_ATTEMPTS,
    );
    if (!event?.payload) {
      this.logger.log(
        buildBackendLog(MetaWebhookEventsService.name, {
          action: 'meta-webhook-event-claim',
          outcome: 'skipped',
          eventId,
          reason: 'not_claimed',
        }),
      );
      return;
    }
    try {
      await this.run(event, event.payload);
    } catch (error) {
      await this.settleFailure(event, error);
    }
    await this.events.markSucceeded(event.id, event.attempts);
    this.logger.log(
      buildBackendLog(MetaWebhookEventsService.name, {
        action: 'meta-webhook-event-process',
        outcome: 'success',
        eventId: event.id,
        field: event.field,
        attempts: event.attempts,
      }),
    );
  }

  private async run(event: MetaWebhookEvent, payload: string): Promise<void> {
    const rawBody = Buffer.from(payload, 'utf8');
    const body = parseBody(rawBody);
    if (!isSingleChange(body)) {
      throw new PermanentEventFailure('unsplittable_body');
    }
    const dto = await this.validate(body);
    await this.messages.processIncomingOrThrow(dto, {
      isRetry: event.attempts > 1,
    });
    await this.templates.handleOrThrow(rawBody);
  }

  private async validate(body: unknown): Promise<WhatsAppWebhookPayloadDto> {
    try {
      return (await this.validation.transform(body, {
        type: 'body',
        metatype: WhatsAppWebhookPayloadDto,
      })) as WhatsAppWebhookPayloadDto;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new PermanentEventFailure('validation_failed');
      }
      throw error;
    }
  }

  /** Records what the failed run means, then always throws for the worker. */
  private async settleFailure(
    event: MetaWebhookEvent,
    error: unknown,
  ): Promise<never> {
    const message = safeErrorMessage(error);
    const permanent = error instanceof PermanentEventFailure;
    const terminal = permanent || event.attempts >= META_WEBHOOK_MAX_ATTEMPTS;
    this.logger.error(
      buildBackendLog(MetaWebhookEventsService.name, {
        action: 'meta-webhook-event-process',
        outcome: terminal ? 'failure' : 'retry',
        eventId: event.id,
        field: event.field,
        attempts: event.attempts,
        terminal,
        ...normalizeError(error),
      }),
    );
    // A database outage can fail this write too. The lease then runs out and
    // the sweep picks the event up, so the run's own error is what is thrown.
    try {
      if (terminal) {
        await this.events.markFailed(event.id, event.attempts, message);
      } else {
        const backoffMs = META_WEBHOOK_BACKOFF_MS * 2 ** (event.attempts - 1);
        await this.events.release(
          event.id,
          event.attempts,
          message,
          new Date(
            Date.now() + backoffMs + META_WEBHOOK_RETRY_GRACE_MS,
          ).toISOString(),
        );
      }
    } catch (recordError) {
      this.logger.error(
        buildBackendLog(MetaWebhookEventsService.name, {
          action: 'meta-webhook-event-record',
          outcome: 'failure',
          eventId: event.id,
          ...normalizeError(recordError),
        }),
      );
    }
    if (terminal) throw new UnrecoverableError(message);
    throw error;
  }

  /**
   * Queues what nothing else will: rows never queued, or left by a crash. Each
   * job gets a fresh id, because BullMQ ignores an add with an id it still
   * holds, and a stalled or duplicate job loses the claim.
   */
  async sweep(): Promise<{ failed: number; queued: number }> {
    const failed = await this.events.failExhausted(META_WEBHOOK_MAX_ATTEMPTS);
    let queued = 0;
    for (let batch = 0; batch < META_WEBHOOK_SWEEP_MAX_BATCHES; batch += 1) {
      const due = await this.events.claimDue(
        META_WEBHOOK_SWEEP_BATCH,
        META_WEBHOOK_SWEEP_RETRY_MS,
      );
      if (due.length === 0) break;
      try {
        await this.enqueue(
          due.map(({ id, attempts }) => ({
            id,
            jobId: `meta-event-${id}-${attempts}-${Date.now()}`,
          })),
        );
      } catch (error) {
        this.logEnqueueFailure(due.length, error);
        break;
      }
      queued += due.length;
      if (due.length < META_WEBHOOK_SWEEP_BATCH) break;
    }
    if (failed > 0 || queued > 0) {
      this.logger.log(
        buildBackendLog(MetaWebhookEventsService.name, {
          action: 'meta-webhook-sweep',
          outcome: 'success',
          failed,
          queued,
        }),
      );
    }
    return { failed, queued };
  }

  async purge(): Promise<void> {
    const result = await this.events.purge(
      META_WEBHOOK_PAYLOAD_RETENTION_DAYS,
      META_WEBHOOK_ROW_RETENTION_DAYS,
    );
    this.logger.log(
      buildBackendLog(MetaWebhookEventsService.name, {
        action: 'meta-webhook-purge',
        outcome: 'success',
        ...result,
      }),
    );
  }
}
