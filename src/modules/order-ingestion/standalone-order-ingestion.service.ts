import { Injectable, Logger } from '@nestjs/common';
import {
  ManualOrderAcceptanceStateError,
  ManualOrderIngestionRepository,
  ManualOrderPayloadConflictError,
  type ManualOrderAcceptanceResult,
} from '../../infrastructure/database/repositories/manual-order-ingestion.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import {
  buildStandaloneOrderEnvelope,
  type CanonicalOrderInput,
  type StandaloneIngestionChannel,
} from '../../shared/commerce/standalone-order-envelope';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  DispatchOutcome,
  WebhookDispatchService,
} from '../webhook-queue/webhook-dispatch.service';
import { namespaceIdempotencyKey } from './standalone-ingestion-keys';
import {
  StandaloneIngestionAcceptanceError,
  StandaloneIngestionConflictError,
  StandaloneIngestionDispatchError,
} from './standalone-order-ingestion.errors';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  StandaloneSourceResolver,
  type StandaloneSource,
  type StandaloneSourceCodeMap,
} from './standalone-source-resolver';
import type {
  AcceptOneOptions,
  AcceptOneResult,
  StandaloneIngestionContext,
} from './standalone-order-ingestion.types';

/**
 * Log actions per channel. Manual keeps the names it has always logged under
 * so existing searches and alerts still match.
 */
const LOG_ACTION_PREFIX: Record<StandaloneIngestionChannel, string> = {
  manual: 'manual-order',
  bulk_import: 'bulk-import-order',
};

/**
 * The one ingestion command for Standalone orders.
 *
 * Channel adapters (the manual form, file import, later the public API) only
 * translate their input into a `CanonicalOrderInput`. Everything after that --
 * the envelope and fingerprint, idempotent acceptance, the optional hold and
 * the dispatch -- happens here, so no channel can build its own payload, write
 * orders or events, or start a verification by another route.
 */
@Injectable()
export class StandaloneOrderIngestionService {
  private readonly logger = new Logger(StandaloneOrderIngestionService.name);

  constructor(
    private readonly acceptance: ManualOrderIngestionRepository,
    private readonly dispatcher: WebhookDispatchService,
    private readonly verificationsRepo: VerificationsRepository,
    private readonly sourceResolver: StandaloneSourceResolver,
  ) {}

  /**
   * Refuses viewers. Exposed on its own so a channel can keep its request
   * validation between the role check and the source lookup.
   */
  assertWritableRole(
    user: AuthenticatedUser,
    codes: StandaloneSourceCodeMap,
  ): void {
    this.sourceResolver.assertWritableRole(user, codes);
  }

  /** The single Standalone source the caller may write orders into. */
  resolveWritableSource(
    user: AuthenticatedUser,
    codes: StandaloneSourceCodeMap,
  ): Promise<StandaloneSource> {
    return this.sourceResolver.resolveWritable(user, codes);
  }

  async acceptOne(
    ctx: StandaloneIngestionContext,
    input: CanonicalOrderInput,
    options: AcceptOneOptions,
  ): Promise<AcceptOneResult> {
    const { channel } = options;
    const logPrefix = LOG_ACTION_PREFIX[channel];
    const { canonicalOrder, submissionFingerprint, rawPayload } =
      buildStandaloneOrderEnvelope({
        ingestionType: channel,
        order: input,
        extras: options.envelopeExtras,
      });

    let acceptance: ManualOrderAcceptanceResult;
    try {
      acceptance = await this.acceptance.accept({
        event: {
          idempotencyKey: namespaceIdempotencyKey(
            channel,
            options.idempotencyKey,
          ),
          storeDomain: ctx.source.platformStoreUrl,
          orgId: ctx.orgId,
          integrationId: ctx.source.id,
          rawPayload,
          submissionFingerprint,
          ...(options.hold ? { hold: options.hold } : {}),
        },
        order: {
          orgId: ctx.orgId,
          integrationId: ctx.source.id,
          externalOrderId: canonicalOrder.externalOrderId,
          orderNumber: canonicalOrder.orderNumber,
          customerPhone: canonicalOrder.customerPhone,
          customerName: canonicalOrder.customerName,
          totalPrice: canonicalOrder.totalPrice,
          currency: canonicalOrder.currency,
          paymentMethod: canonicalOrder.paymentMethod,
          rawPayload,
          isTest: false,
        },
      });
    } catch (error) {
      if (error instanceof ManualOrderPayloadConflictError) {
        throw new StandaloneIngestionConflictError();
      }
      this.logger.error(
        buildBackendLog(StandaloneOrderIngestionService.name, {
          action: `${logPrefix}-accept`,
          outcome: 'failure',
          channel,
          orgId: ctx.orgId,
          integrationId: ctx.source.id,
          reason:
            error instanceof ManualOrderAcceptanceStateError
              ? 'acceptance_state_invalid'
              : 'database_failure',
          ...normalizeError(error),
        }),
      );
      throw new StandaloneIngestionAcceptanceError();
    }

    if (options.hold) {
      this.logger.log(
        buildBackendLog(StandaloneOrderIngestionService.name, {
          action: `${logPrefix}-hold`,
          outcome: 'success',
          channel,
          orgId: ctx.orgId,
          integrationId: ctx.source.id,
          orderId: acceptance.order.id,
          webhookEventId: acceptance.eventId,
          holdGroupId: options.hold.groupId,
          duplicate: acceptance.duplicate,
        }),
      );
      return {
        orderId: acceptance.order.id,
        eventId: acceptance.eventId,
        duplicate: acceptance.duplicate,
        held: true,
      };
    }

    // `dispatchById` reports 'not_claimed' and 'failed' by returning them, not
    // by throwing. Discarding the return value meant an order whose job never
    // reached the queue still answered 202 "accepted" and logged success, which
    // is why these failures were invisible from both the UI and the logs.
    let outcome: DispatchOutcome;
    try {
      outcome = await this.dispatcher.dispatchById(acceptance.eventId);
    } catch (error) {
      this.logger.error(
        buildBackendLog(StandaloneOrderIngestionService.name, {
          action: `${logPrefix}-dispatch`,
          outcome: 'failure',
          channel,
          orgId: ctx.orgId,
          integrationId: ctx.source.id,
          orderId: acceptance.order.id,
          webhookEventId: acceptance.eventId,
          ...normalizeError(error),
        }),
      );
      outcome = 'failed';
    }
    if (outcome !== 'dispatched') {
      this.logger.error(
        buildBackendLog(StandaloneOrderIngestionService.name, {
          action: `${logPrefix}-dispatch`,
          outcome: 'failure',
          reason: outcome,
          channel,
          orgId: ctx.orgId,
          integrationId: ctx.source.id,
          orderId: acceptance.order.id,
          webhookEventId: acceptance.eventId,
        }),
      );
      // The order and its event are committed, so retrying with the same key
      // takes the duplicate branch of `accept()` and re-dispatches that same
      // event. The retry cannot create a second order.
      throw new StandaloneIngestionDispatchError();
    }

    let verificationId: string | undefined;
    try {
      verificationId = (
        await this.verificationsRepo.findByOrderId(acceptance.order.id)
      )?.id;
    } catch (error) {
      this.logger.warn(
        buildBackendLog(StandaloneOrderIngestionService.name, {
          action: `${logPrefix}-verification-read`,
          outcome: 'failure',
          channel,
          orgId: ctx.orgId,
          integrationId: ctx.source.id,
          orderId: acceptance.order.id,
          ...normalizeError(error),
        }),
      );
    }

    this.logger.log(
      buildBackendLog(StandaloneOrderIngestionService.name, {
        action: `${logPrefix}-accept`,
        outcome: 'success',
        channel,
        orgId: ctx.orgId,
        integrationId: ctx.source.id,
        orderId: acceptance.order.id,
        webhookEventId: acceptance.eventId,
        duplicate: acceptance.duplicate,
      }),
    );
    return {
      orderId: acceptance.order.id,
      eventId: acceptance.eventId,
      ...(verificationId ? { verificationId } : {}),
      duplicate: acceptance.duplicate,
      held: false,
    };
  }
}
