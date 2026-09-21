import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderImportReleaseRepository,
  type BatchForRelease,
} from '../../../infrastructure/database/repositories/order-import-release.repository';
import { WebhookEventsRepository } from '../../../infrastructure/database/repositories/webhook-events.repository';
import { readBulkImportConfig } from '../../../shared/config/bulk-import.config';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import { quietHoursConfigOf } from '../../../shared/utils/quiet-hours.util';
import { normalizeIdempotencyKey } from '../../../shared/validation/idempotency-key';
import type { AuthenticatedUser } from '../../auth/guards/dual-auth.guard';
import { StandaloneSendReadinessService } from '../../order-ingestion/standalone-send-readiness.service';
import type { StandaloneSource } from '../../order-ingestion/standalone-source-resolver';
import type { OrderImportBatchDetailDto } from '../dto/order-import.dto';
import type {
  OrderImportStartQuoteDto,
  OrderImportStopResponseDto,
  StartOrderImportDto,
} from '../dto/order-import-release.dto';
import { OrderImportDetailService } from '../order-import-detail.service';
import {
  IMPORT_IDEMPOTENCY_CODES,
  orderImportError,
} from '../order-imports.errors';
import {
  BULK_IMPORT_ATTESTATIONS,
  CURRENT_ATTESTATION_VERSION,
} from './attestation';
import { toImportBlockers } from './import-blockers';
import { OrderImportReleaseScheduler } from './order-import-release.scheduler';
import {
  QUOTE_TOKEN_TTL_MS,
  signQuoteToken,
  verifyQuoteToken,
} from './quote-token';
import { estimateReleaseMinutes } from './release-policy';

/** A start or resume past this point answers from the batch's state. */
const STARTED_STATUSES = new Set([
  'releasing',
  'paused',
  'completed',
  'stopped',
]);
const QUOTABLE_STATUSES = new Set(['awaiting_start', 'paused']);

/**
 * The start checkpoint (US-04.6-07 AC1–AC4, AC7, AC8): the quote, the
 * attested start, stop and resume. Nothing here sends; a start only makes the
 * batch `releasing` and ensures the organization's release ticks run.
 */
@Injectable()
export class OrderImportReleaseService {
  private readonly logger = new Logger(OrderImportReleaseService.name);

  constructor(
    private readonly releases: OrderImportReleaseRepository,
    private readonly webhookEvents: WebhookEventsRepository,
    private readonly readiness: StandaloneSendReadinessService,
    private readonly scheduler: OrderImportReleaseScheduler,
    private readonly detail: OrderImportDetailService,
    private readonly config: ConfigService,
  ) {}

  async quote(
    user: AuthenticatedUser,
    source: StandaloneSource,
    batchId: string,
  ): Promise<OrderImportStartQuoteDto> {
    const batch = await this.loadBatch(user, source, batchId);
    if (!QUOTABLE_STATUSES.has(batch.status))
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
        status: batch.status,
      });
    return this.buildQuote(source, batch, new Date());
  }

  /**
   * Start confirmation for every held order, exactly once.
   *
   * The token proves what the merchant saw; the gates are still re-evaluated
   * here, because the balance or settings may have changed since. A change
   * that still passes every gate is accepted: the merchant agreed to N orders,
   * not to a balance.
   */
  async start(
    user: AuthenticatedUser,
    source: StandaloneSource,
    batchId: string,
    idempotencyHeader: string | undefined,
    body: StartOrderImportDto,
  ): Promise<OrderImportBatchDetailDto> {
    const key = normalizeIdempotencyKey(
      idempotencyHeader,
      IMPORT_IDEMPOTENCY_CODES,
    );
    const now = new Date();
    const batch = await this.loadBatch(user, source, batchId);
    if (STARTED_STATUSES.has(batch.status))
      return this.replayOrConflict(user, batch, key);
    if (batch.status === 'not_started')
      throw orderImportError('IMPORT_START_WINDOW_EXPIRED');
    if (batch.status !== 'awaiting_start')
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
        status: batch.status,
      });
    if (body.attestationVersion !== CURRENT_ATTESTATION_VERSION)
      throw orderImportError('IMPORT_ATTESTATION_REQUIRED', {
        attestationVersion: CURRENT_ATTESTATION_VERSION,
      });
    if (this.deadlinePassed(batch, now))
      throw orderImportError('IMPORT_START_WINDOW_EXPIRED');

    const quote = await this.buildQuote(source, batch, now);
    if (this.isStale(body.quoteToken, quote, batchId, now))
      throw orderImportError('IMPORT_QUOTE_STALE', { quote });
    this.assertNoBlockers(quote);

    const claim = await this.releases.claimForStart({
      orgId: user.orgId,
      batchId,
      key,
      attestedBy: user.userId,
      attestationVersion: CURRENT_ATTESTATION_VERSION,
      orders: quote.orders,
      now,
    });
    if (claim === 'key_taken')
      throw orderImportError('IMPORT_IDEMPOTENCY_CONFLICT');
    if (claim === 'not_startable') {
      // Another request won, or the deadline passed, between read and update.
      const current = await this.loadBatch(user, source, batchId);
      if (STARTED_STATUSES.has(current.status))
        return this.replayOrConflict(user, current, key);
      throw orderImportError('IMPORT_START_WINDOW_EXPIRED');
    }

    await this.scheduler.ensure(user.orgId);
    this.logger.log(
      buildBackendLog(OrderImportReleaseService.name, {
        action: 'order-import-start',
        outcome: 'success',
        orgId: user.orgId,
        integrationId: source.id,
        batchId,
        orders: quote.orders,
        accountingMode: quote.accountingMode,
      }),
    );
    return this.detail.detail(user, batchId);
  }

  /**
   * Withdraw every order not yet released (AC8). Idempotent: a second stop,
   * or one repeating after a crash between the two steps, withdraws whatever
   * is still held and reports the same final counts.
   */
  async stop(
    user: AuthenticatedUser,
    source: StandaloneSource,
    batchId: string,
  ): Promise<OrderImportStopResponseDto> {
    const now = new Date();
    let batch = await this.loadBatch(user, source, batchId);
    if (batch.status === 'releasing' || batch.status === 'paused') {
      // The status moves first, so no later tick selects this batch; a tick
      // already past its select can only release rows that are still held,
      // and the withdraw below takes the rest. Each event ends up one or the
      // other, never both.
      await this.releases.markStopped({ orgId: user.orgId, batchId, now });
      batch = await this.loadBatch(user, source, batchId);
    }
    if (batch.status !== 'stopped')
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
        status: batch.status,
      });

    const withdrawnNow = await this.webhookEvents.withdrawHeld(user.orgId, {
      groupId: batchId,
    });
    const counts = await this.releases.holdCounts(user.orgId, batchId);
    this.logger.log(
      buildBackendLog(OrderImportReleaseService.name, {
        action: 'order-import-stop',
        outcome: 'success',
        orgId: user.orgId,
        batchId,
        released: counts.released,
        withdrawn: counts.withdrawn,
        withdrawnNow: withdrawnNow.length,
      }),
    );
    return {
      batchId,
      status: 'stopped',
      released: counts.released,
      withdrawn: counts.withdrawn,
    };
  }

  /**
   * Continue a paused batch (AC7). The quote gates run again; the start's
   * attestation still covers it. A pause by Akeed staff is not the
   * merchant's to lift.
   */
  async resume(
    user: AuthenticatedUser,
    source: StandaloneSource,
    batchId: string,
  ): Promise<OrderImportBatchDetailDto> {
    const now = new Date();
    const batch = await this.loadBatch(user, source, batchId);
    if (batch.status === 'releasing') {
      await this.scheduler.ensure(user.orgId);
      return this.detail.detail(user, batchId);
    }
    if (batch.status !== 'paused')
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
        status: batch.status,
      });
    if (batch.pausedReason === 'staff_paused')
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
        status: batch.status,
        reason: 'staff_paused',
      });
    if (this.deadlinePassed(batch, now))
      throw orderImportError('IMPORT_START_WINDOW_EXPIRED');

    this.assertNoBlockers(await this.buildQuote(source, batch, now));

    const resumed = await this.releases.resume({
      orgId: user.orgId,
      batchId,
      now,
    });
    if (!resumed) {
      const current = await this.loadBatch(user, source, batchId);
      if (current.status !== 'releasing')
        throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
          status: current.status,
        });
    }
    await this.scheduler.ensure(user.orgId);
    this.logger.log(
      buildBackendLog(OrderImportReleaseService.name, {
        action: 'order-import-resume',
        outcome: 'success',
        orgId: user.orgId,
        batchId,
        from: batch.pausedReason,
      }),
    );
    return this.detail.detail(user, batchId);
  }

  private async buildQuote(
    source: StandaloneSource,
    batch: BatchForRelease,
    now: Date,
  ): Promise<OrderImportStartQuoteDto> {
    const { held } = await this.releases.holdCounts(batch.orgId, batch.id);
    const readiness = await this.readiness.evaluate(source, {
      required: held,
      mode: 'all',
    });
    const blockers = toImportBlockers(readiness.blockers);
    if (this.deadlinePassed(batch, now))
      blockers.push({ code: 'IMPORT_START_WINDOW_EXPIRED' });

    const { releasePerMinute, quoteSecret } = readBulkImportConfig(this.config);
    const quietHours = quietHoursConfigOf(source);
    const { snapshot } = readiness;
    const balance =
      snapshot.accountingMode === 'prepaid_credit'
        ? snapshot.creditsAvailable
        : snapshot.slotsRemaining;
    const expiresAt = now.getTime() + QUOTE_TOKEN_TTL_MS;
    return {
      batchId: batch.id,
      orders: held,
      accountingMode: snapshot.accountingMode,
      creditsAvailable: snapshot.creditsAvailable,
      slotsRemaining: snapshot.slotsRemaining,
      estimatedCreditsMin: held,
      estimatedCreditsMax: held * (source.followUpEnabled ? 2 : 1),
      ratePerMinute: releasePerMinute,
      estimatedDurationMinutes: estimateReleaseMinutes({
        orders: held,
        ratePerMinute: releasePerMinute,
        now,
        quietHours,
      }),
      quietHours: {
        enabled: quietHours.enabled,
        start: source.quietHoursStart,
        end: source.quietHoursEnd,
        timezone: source.timezone,
      },
      startDeadlineAt: batch.startDeadlineAt,
      blockers,
      quoteToken: signQuoteToken(
        { batchId: batch.id, orders: held, balance, expiresAt },
        quoteSecret,
      ),
      quoteExpiresAt: new Date(expiresAt).toISOString(),
      attestation: {
        version: CURRENT_ATTESTATION_VERSION,
        text: { ...BULK_IMPORT_ATTESTATIONS[CURRENT_ATTESTATION_VERSION] },
      },
    };
  }

  /**
   * AC3: stale when the token is missing, forged or expired, when N changed,
   * or when the balance changed so that a gate now fails.
   */
  private isStale(
    token: string | undefined,
    fresh: OrderImportStartQuoteDto,
    batchId: string,
    now: Date,
  ): boolean {
    if (!token) return true;
    const check = verifyQuoteToken(
      token,
      readBulkImportConfig(this.config).quoteSecret,
      now,
    );
    if (!check.ok) return true;
    const { claims } = check;
    if (claims.batchId !== batchId || claims.orders !== fresh.orders)
      return true;
    const balance =
      fresh.accountingMode === 'prepaid_credit'
        ? fresh.creditsAvailable
        : fresh.slotsRemaining;
    return claims.balance !== balance && fresh.blockers.length > 0;
  }

  private assertNoBlockers(quote: OrderImportStartQuoteDto): void {
    const [first] = quote.blockers;
    if (first)
      throw orderImportError(first.code, {
        blockers: quote.blockers,
        ...(first.reason ? { reason: first.reason } : {}),
      });
  }

  private deadlinePassed(batch: BatchForRelease, now: Date): boolean {
    return (
      !batch.startDeadlineAt ||
      Date.parse(batch.startDeadlineAt) <= now.getTime()
    );
  }

  /** Org-scoped, and only a batch of the caller's current source. */
  private async loadBatch(
    user: AuthenticatedUser,
    source: StandaloneSource,
    batchId: string,
  ): Promise<BatchForRelease> {
    const batch = await this.releases.findBatch(user.orgId, batchId);
    if (!batch || batch.integrationId !== source.id)
      throw orderImportError('IMPORT_BATCH_NOT_FOUND');
    return batch;
  }

  /**
   * The same key replays the current state (and makes sure its ticks run,
   * in case the first attempt died before scheduling them); a different key
   * is a second start, which must be told the batch has moved on.
   */
  private async replayOrConflict(
    user: AuthenticatedUser,
    batch: BatchForRelease,
    key: string,
  ): Promise<OrderImportBatchDetailDto> {
    if (batch.startIdempotencyKey && batch.startIdempotencyKey === key) {
      if (batch.status === 'releasing') await this.scheduler.ensure(user.orgId);
      return this.detail.detail(user, batch.id);
    }
    throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
      status: batch.status,
    });
  }
}
