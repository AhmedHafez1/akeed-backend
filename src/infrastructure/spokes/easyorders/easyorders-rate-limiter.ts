import { Injectable } from '@nestjs/common';

/**
 * Akeed's share of the EasyOrders rate limit (contract record section 8).
 * EasyOrders documents 40 requests a minute and does not say what the limit
 * applies to, so it is treated as shared by everything that touches a store
 * and Akeed spends at most 30 of it per integration.
 */
export const EASYORDERS_REQUESTS_PER_MINUTE = 30;

/**
 * Order lookups stop here so the rest of the minute stays free for outcome
 * status updates, which go first.
 */
export const EASYORDERS_LOOKUPS_PER_MINUTE = 20;

const WINDOW_MS = 60_000;
const MAX_JITTER_MS = 10_000;
const MAX_TRACKED_INTEGRATIONS = 5_000;

export type EasyOrdersRequestPurpose = 'lookup' | 'outcome';

export type EasyOrdersRateDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

interface IntegrationWindow {
  minute: number;
  used: number;
  lookups: number;
  pausedUntil: number;
}

/** "Wait for the next minute", plus jitter so paused jobs do not wake as one. */
export function msUntilNextMinute(
  now: number,
  random: () => number = Math.random,
): number {
  return WINDOW_MS - (now % WINDOW_MS) + Math.floor(random() * MAX_JITTER_MS);
}

/**
 * One budget per integration, never a global one, so a busy store cannot
 * starve another. The window is the clock minute EasyOrders describes.
 *
 * The counters live in this process, which is correct for one API instance,
 * like the app's other throttlers.
 */
@Injectable()
export class EasyOrdersRateLimiter {
  private readonly windows = new Map<string, IntegrationWindow>();

  acquire(
    integrationId: string,
    purpose: EasyOrdersRequestPurpose,
    now: number = Date.now(),
    random: () => number = Math.random,
  ): EasyOrdersRateDecision {
    const window = this.windowFor(integrationId, now);
    if (window.pausedUntil > now)
      return { allowed: false, retryAfterMs: window.pausedUntil - now };
    if (
      window.used >= EASYORDERS_REQUESTS_PER_MINUTE ||
      (purpose === 'lookup' && window.lookups >= EASYORDERS_LOOKUPS_PER_MINUTE)
    )
      return { allowed: false, retryAfterMs: msUntilNextMinute(now, random) };
    window.used += 1;
    if (purpose === 'lookup') window.lookups += 1;
    return { allowed: true };
  }

  /** After a 429: every call for this integration waits, not only the caller. */
  pause(integrationId: string, delayMs: number, now: number = Date.now()) {
    const window = this.windowFor(integrationId, now);
    window.pausedUntil = Math.max(window.pausedUntil, now + delayMs);
  }

  private windowFor(integrationId: string, now: number): IntegrationWindow {
    const minute = Math.floor(now / WINDOW_MS);
    const existing = this.windows.get(integrationId);
    if (existing) {
      if (existing.minute !== minute) {
        existing.minute = minute;
        existing.used = 0;
        existing.lookups = 0;
      }
      return existing;
    }
    if (this.windows.size >= MAX_TRACKED_INTEGRATIONS) this.prune(minute, now);
    const created = { minute, used: 0, lookups: 0, pausedUntil: 0 };
    this.windows.set(integrationId, created);
    return created;
  }

  private prune(minute: number, now: number): void {
    for (const [integrationId, window] of this.windows)
      if (window.minute !== minute && window.pausedUntil <= now)
        this.windows.delete(integrationId);
  }
}
