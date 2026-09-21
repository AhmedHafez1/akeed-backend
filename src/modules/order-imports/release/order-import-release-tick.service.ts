import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationsRepository } from '../../../infrastructure/database/repositories/integrations.repository';
import { OrderImportReleaseRepository } from '../../../infrastructure/database/repositories/order-import-release.repository';
import { WebhookEventsRepository } from '../../../infrastructure/database/repositories/webhook-events.repository';
import { readBulkImportConfig } from '../../../shared/config/bulk-import.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import {
  adjustForQuietHours,
  isInsideQuietHours,
  quietHoursConfigOf,
} from '../../../shared/utils/quiet-hours.util';
import { StandaloneSendReadinessService } from '../../order-ingestion/standalone-send-readiness.service';
import { WebhookDispatchService } from '../../webhook-queue/webhook-dispatch.service';
import { toImportBlockers } from './import-blockers';
import { OrderImportReleaseScheduler } from './order-import-release.scheduler';
import { releaseBudgetPerTick } from './release-policy';

/**
 * Released events are due at once. The claim compares `next_dispatch_at` with
 * the database clock, so a worker clock running ahead of it would make the
 * inline dispatch miss its own claim; a minute of slack removes that race.
 */
const DUE_SLACK_MS = 60_000;

export type ReleaseTickOutcome =
  | { kind: 'idle' }
  | { kind: 'quiet_hours'; until: string }
  | { kind: 'paused'; reason: string; batches: number }
  | { kind: 'released'; released: number; completed: number };

/**
 * One paced-release step for an organization (AC5–AC7, AC9).
 *
 * The only code in the epic that turns a held import order into a send. It
 * does that through the same primitives every order uses: `releaseHeld` makes
 * the event dispatchable, and `dispatchById` hands it to the one shared
 * pipeline, so from here on an imported order is verified, billed, followed
 * up and retried exactly like a manual or Shopify one.
 *
 * Safe to run twice at once: `releaseHeld` is guarded by `hold_state='held'`
 * and the dispatch claim by its lease, so an overlap can only exceed the pace
 * for one tick, never send an order twice.
 */
@Injectable()
export class OrderImportReleaseTickService {
  private readonly logger = new Logger(OrderImportReleaseTickService.name);

  constructor(
    private readonly releases: OrderImportReleaseRepository,
    private readonly integrations: IntegrationsRepository,
    private readonly readiness: StandaloneSendReadinessService,
    private readonly webhookEvents: WebhookEventsRepository,
    private readonly dispatcher: WebhookDispatchService,
    private readonly scheduler: OrderImportReleaseScheduler,
    private readonly config: ConfigService,
  ) {}

  async tick(orgId: string, now = new Date()): Promise<ReleaseTickOutcome> {
    const batches = await this.releases.listReleasing(orgId);
    if (batches.length === 0) {
      await this.scheduler.remove(orgId);
      return { kind: 'idle' };
    }

    // Settings are read fresh every tick: a timezone, quiet-hours or
    // auto-verify change made mid-release applies to the next message.
    const integrationIds = new Set(batches.map((batch) => batch.integrationId));
    const sources = (await this.integrations.findByOrg(orgId)).filter(
      (source) => integrationIds.has(source.id),
    );

    let quietUntil: Date | null = null;
    for (const source of sources) {
      const quietHours = quietHoursConfigOf(source);
      if (!isInsideQuietHours(now, quietHours)) continue;
      const resumesAt = adjustForQuietHours(now, quietHours);
      if (!quietUntil || resumesAt > quietUntil) quietUntil = resumesAt;
    }
    if (quietUntil) {
      const until = quietUntil.toISOString();
      await this.releases.setQuietHoursUntil(orgId, until, now);
      this.log('quiet_hours', orgId, { batches: batches.length });
      return { kind: 'quiet_hours', until };
    }
    await this.releases.setQuietHoursUntil(orgId, null, now);

    const reason =
      sources.length < integrationIds.size
        ? 'IMPORT_SETUP_INCOMPLETE'
        : await this.firstBlocker(sources);
    if (reason) {
      const paused = await this.releases.pauseReleasing(orgId, reason, now);
      await this.scheduler.remove(orgId);
      this.logger.warn(
        buildBackendLog(OrderImportReleaseTickService.name, {
          action: 'order-import-release-pause',
          outcome: 'skipped',
          orgId,
          reason,
          batches: paused.length,
        }),
      );
      return { kind: 'paused', reason, batches: paused.length };
    }

    const rate = readBulkImportConfig(this.config).releasePerMinute;
    const held = await this.releases.selectHeldForRelease(
      orgId,
      releaseBudgetPerTick(rate),
    );
    const released = await this.webhookEvents.releaseHeld(
      orgId,
      held.map((event) => event.eventId),
      new Date(now.getTime() - DUE_SLACK_MS).toISOString(),
    );
    let dispatchFailures = 0;
    for (const eventId of released) {
      // A failure leaves the event `released` with `dispatch_required`, so the
      // existing reconciler re-dispatches it; the tick moves on.
      try {
        const outcome = await this.dispatcher.dispatchById(eventId);
        if (outcome === 'dispatched') continue;
        dispatchFailures += 1;
        this.logger.warn(
          buildBackendLog(OrderImportReleaseTickService.name, {
            action: 'order-import-release-dispatch',
            outcome: 'failure',
            orgId,
            webhookEventId: eventId,
            reason: outcome,
          }),
        );
      } catch (error) {
        dispatchFailures += 1;
        this.logger.warn(
          buildBackendLog(OrderImportReleaseTickService.name, {
            action: 'order-import-release-dispatch',
            outcome: 'failure',
            orgId,
            webhookEventId: eventId,
            ...normalizeError(error),
          }),
        );
      }
    }

    const completed = await this.releases.completeDrained(orgId, now);
    if (completed.length > 0) {
      const remaining = await this.releases.listReleasing(orgId);
      if (remaining.length === 0) await this.scheduler.remove(orgId);
    }
    this.log('released', orgId, {
      batches: batches.length,
      budget: releaseBudgetPerTick(rate),
      released: released.length,
      dispatchFailures,
      completed: completed.length,
    });
    return {
      kind: 'released',
      released: released.length,
      completed: completed.length,
    };
  }

  /** The same gates as the quote, for the next single message. */
  private async firstBlocker(
    sources: Awaited<ReturnType<IntegrationsRepository['findByOrg']>>,
  ): Promise<string | null> {
    for (const source of sources) {
      const readiness = await this.readiness.evaluate(source, {
        required: 1,
        mode: 'all',
      });
      const [blocker] = toImportBlockers(readiness.blockers);
      if (blocker) return blocker.code;
    }
    return null;
  }

  private log(
    result: string,
    orgId: string,
    fields: Record<string, number>,
  ): void {
    this.logger.log(
      buildBackendLog(OrderImportReleaseTickService.name, {
        action: 'order-import-release-tick',
        outcome: 'success',
        result,
        orgId,
        ...fields,
      }),
    );
  }
}
