import {
  adjustForQuietHours,
  quietHoursConfigOf,
} from '../../shared/utils/quiet-hours.util';

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
