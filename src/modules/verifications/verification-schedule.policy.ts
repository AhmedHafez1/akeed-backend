import {
  adjustForQuietHours,
  quietHoursConfigOf,
} from '../../shared/utils/quiet-hours.util';
import {
  projectAutoCancelAt,
  type AutoCancelStatus,
} from '../../shared/verification/auto-cancel.policy';

/**
 * When a list row's next message is due, for the dashboard's "Scheduled" and
 * "Reminder scheduled for" hints. Every answer is a future ISO time or null:
 * a time that has passed means the worker is on it, so the row stops claiming
 * to be scheduled.
 */

/** The integration settings these rules read. */
export interface ScheduleSource {
  followUpEnabled: boolean | null;
  quietHoursEnabled: boolean | null;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string | null;
}

/** Statuses a sent message waits in for the customer's answer. */
const AWAITING_REPLY_STATUSES = new Set(['sent', 'delivered', 'read']);

function futureOrNull(iso: string | null | undefined, now: Date) {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  return Number.isFinite(at) && at > now.getTime() ? iso : null;
}

/**
 * A pending row's first message, deliberately held back by the send delay or
 * quiet hours. Null once anything was sent.
 */
export function resolveScheduledFor(
  verification: {
    status: string;
    lastSentAt?: string | null;
    nextRetryAt?: string | null;
  },
  now = new Date(),
): string | null {
  if (verification.status !== 'pending' || verification.lastSentAt) return null;
  return futureOrNull(verification.nextRetryAt, now);
}

/**
 * An imported order queued behind the paced release while quiet hours pause
 * it: it goes out when they end. Any other stage has no known time.
 */
export function resolveHeldScheduledFor(
  stage: string,
  source: ScheduleSource | undefined,
  now = new Date(),
): string | null {
  if (stage !== 'queued' || !source) return null;
  const resumesAt = adjustForQuietHours(now, quietHoursConfigOf(source));
  return resumesAt.getTime() > now.getTime() ? resumesAt.toISOString() : null;
}

/**
 * The reminder still due for a message the customer has not answered: only
 * while no reminder went out, none was skipped or failed, and the source
 * still sends reminders.
 */
export function resolveFollowUpScheduledFor(
  verification: {
    status: string;
    followUpAttempts?: number | null;
    followUpSentAt?: string | null;
    metadata?: unknown;
  },
  source: ScheduleSource | undefined,
  now = new Date(),
): string | null {
  if (!AWAITING_REPLY_STATUSES.has(verification.status)) return null;
  if ((verification.followUpAttempts ?? 0) > 0) return null;
  if (verification.followUpSentAt) return null;
  if (source?.followUpEnabled !== true) return null;

  const metadata =
    verification.metadata && typeof verification.metadata === 'object'
      ? (verification.metadata as Record<string, unknown>)
      : {};
  if (metadata.follow_up_skipped || metadata.follow_up_failed) return null;
  const dueAt = metadata.follow_up_due_at;
  return futureOrNull(typeof dueAt === 'string' ? dueAt : null, now);
}

/** The automatic-cancellation settings a row's projection reads. */
export interface AutoCancelScheduleSource extends ScheduleSource {
  autoCancelEnabled?: boolean | null;
  escalationEnabled?: boolean | null;
  escalationDelayMinutes?: number | null;
}

/** The row's automatic cancellation, as the confirmations list shows it. */
export interface AutoCancelView {
  /** `projected` while the order has not reached `no_reply` yet. */
  state: 'projected' | AutoCancelStatus;
  /** When it is due; null when it is not going to run on its own. */
  scheduled_for: string | null;
  reason: string | null;
  excluded: boolean;
  late_reply: boolean;
}

/**
 * What the merchant is told about a row's automatic cancellation. A decided
 * row reports its own state; an order still waiting for the customer reports
 * the time its escalation would lead to, by the same rules, for display.
 * Null when the store does not use automatic cancellation and nothing was
 * decided for the row.
 */
export function resolveAutoCancelView(
  verification: {
    status: string;
    lastSentAt?: string | null;
    deliveredAt?: string | null;
    readAt?: string | null;
    followUpAttempts?: number | null;
    followUpSentAt?: string | null;
    customerLastMessageAt?: string | null;
    autoCancelExcludedAt?: string | null;
    metadata?: unknown;
  },
  source: AutoCancelScheduleSource | undefined,
  row:
    | {
        status: AutoCancelStatus;
        dueAt: string | null;
        reason: string | null;
        lateReplyAt: string | null;
      }
    | undefined,
  isTest: boolean,
  now = new Date(),
): AutoCancelView | null {
  const excluded = Boolean(verification.autoCancelExcludedAt);
  if (row) {
    return {
      state: row.status,
      scheduled_for:
        row.status === 'scheduled' ? futureOrNull(row.dueAt, now) : null,
      reason: row.reason,
      excluded,
      late_reply: Boolean(row.lateReplyAt),
    };
  }
  if (source?.autoCancelEnabled !== true || isTest) return null;
  if (!AWAITING_REPLY_STATUSES.has(verification.status)) return null;
  const view: AutoCancelView = {
    state: 'projected',
    scheduled_for: null,
    reason: null,
    excluded,
    late_reply: false,
  };
  if (excluded || verification.customerLastMessageAt) return view;

  const sentAt = verification.lastSentAt
    ? new Date(verification.lastSentAt).getTime()
    : NaN;
  const escalationMinutes = source.escalationDelayMinutes ?? 0;
  if (
    !Number.isFinite(sentAt) ||
    source.escalationEnabled !== true ||
    escalationMinutes <= 0
  )
    return view;

  const pendingFollowUp = resolveFollowUpScheduledFor(
    verification,
    source,
    now,
  );
  let escalationDueAt = adjustForQuietHours(
    new Date(sentAt + escalationMinutes * 60_000),
    quietHoursConfigOf(source),
  );
  if (
    pendingFollowUp &&
    escalationDueAt.getTime() <= new Date(pendingFollowUp).getTime()
  ) {
    escalationDueAt = new Date(new Date(pendingFollowUp).getTime() + 60_000);
  }
  const metadata =
    verification.metadata && typeof verification.metadata === 'object'
      ? (verification.metadata as Record<string, unknown>)
      : {};
  const blocked = metadata.follow_up_skipped ?? metadata.follow_up_failed;
  const projected = projectAutoCancelAt(
    {
      enabled: true,
      isTestOrder: false,
      initialDeliveredAt: verification.deliveredAt ?? verification.readAt,
      followUpAttempted:
        Boolean(pendingFollowUp) ||
        (verification.followUpAttempts ?? 0) > 0 ||
        Boolean(verification.followUpSentAt),
      followUpBlockedReason: typeof blocked === 'string' ? blocked : null,
      // Display only: a reminder still to go out, or one that went out, is
      // counted as delivered when it is due or was sent.
      followUpDeliveredAt: pendingFollowUp ?? verification.followUpSentAt,
    },
    escalationDueAt,
  );
  return {
    ...view,
    scheduled_for: projected
      ? futureOrNull(projected.toISOString(), now)
      : null,
  };
}
