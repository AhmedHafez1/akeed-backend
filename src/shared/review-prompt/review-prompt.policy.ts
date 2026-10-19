import type {
  ReviewPromptMerchantAction,
  ReviewPromptState,
  ReviewPromptVariant,
  ReviewRequestCode,
} from './review-prompt.types';

/** "Not now" hides the card for this long; a second "Not now" ends it. */
export const REVIEW_PROMPT_SNOOZE_DAYS = 14;

/** The card leads with the store's results only from this many confirmations. */
export const REVIEW_PROMPT_RESULTS_THRESHOLD = 10;

const DAY_MS = 86_400_000;

export interface ReviewPromptStateRow {
  state: ReviewPromptState;
  snoozedUntil: string | null;
  snoozeCount: number;
}

/** The store's state as of `now`: a snooze that has run out is eligible again. */
export function effectiveReviewPromptState(
  row: ReviewPromptStateRow | undefined,
  now: Date,
): ReviewPromptState {
  if (!row) return 'eligible';
  if (row.state !== 'snoozed') return row.state;
  const until = row.snoozedUntil ? Date.parse(row.snoozedUntil) : NaN;
  return Number.isFinite(until) && until > now.getTime()
    ? 'snoozed'
    : 'eligible';
}

/** What the store's state becomes after a Reviews API result. */
function stateAfterResult(code: ReviewRequestCode): ReviewPromptState | null {
  switch (code) {
    case 'success':
      return 'reviewed_prompted';
    case 'already-reviewed':
      return 'reviewed';
    case 'merchant-ineligible':
      return 'ineligible';
    case 'cooldown-period':
    case 'annual-limit-reached':
    case 'mobile-app':
    case 'recently-installed':
    case 'unavailable':
    case 'cancelled':
      return 'clicked';
    case 'already-open':
    case 'open-in-progress':
      return null;
  }
}

export interface ReviewPromptChange {
  state?: ReviewPromptState;
  snoozedUntil?: string | null;
  snoozeCount?: number;
  /** Count one impression and stamp it. */
  shown?: true;
  lastResultCode?: ReviewRequestCode;
  /** The event logged for this change. */
  event: 'shown' | 'clicked' | 'result' | 'snoozed' | 'declined';
}

/**
 * What one merchant report does to the store's state. 'replay' changes and
 * logs nothing: an impression of a prompt that is not showing, or a second
 * "Not now" while the first snooze is still running (a double click or a
 * second tab), which must not turn into a decline. Everything else applies,
 * and the latest report wins.
 */
export type ReviewPromptDecision =
  | { kind: 'apply'; change: ReviewPromptChange }
  | { kind: 'replay' };

export function decideMerchantEvent(
  row: ReviewPromptStateRow | undefined,
  action: ReviewPromptMerchantAction,
  now: Date,
  code?: ReviewRequestCode,
): ReviewPromptDecision {
  const current = effectiveReviewPromptState(row, now);
  switch (action) {
    case 'shown':
      return current === 'eligible'
        ? { kind: 'apply', change: { shown: true, event: 'shown' } }
        : { kind: 'replay' };
    case 'clicked':
      return {
        kind: 'apply',
        change: { state: 'clicked', snoozedUntil: null, event: 'clicked' },
      };
    case 'result': {
      if (!code) return { kind: 'replay' };
      const next = stateAfterResult(code);
      return {
        kind: 'apply',
        change: next
          ? {
              state: next,
              snoozedUntil: null,
              lastResultCode: code,
              event: 'result',
            }
          : { lastResultCode: code, event: 'result' },
      };
    }
    case 'not_now': {
      if (current === 'snoozed' || current === 'declined') {
        return { kind: 'replay' };
      }
      const snoozeCount = row?.snoozeCount ?? 0;
      if (snoozeCount >= 1) {
        return {
          kind: 'apply',
          change: {
            state: 'declined',
            snoozedUntil: null,
            snoozeCount: snoozeCount + 1,
            event: 'declined',
          },
        };
      }
      return {
        kind: 'apply',
        change: {
          state: 'snoozed',
          snoozedUntil: new Date(
            now.getTime() + REVIEW_PROMPT_SNOOZE_DAYS * DAY_MS,
          ).toISOString(),
          snoozeCount: 1,
          event: 'snoozed',
        },
      };
    }
  }
}

export function reviewPromptVariantFor(
  confirmed: number | null,
): ReviewPromptVariant {
  return confirmed !== null && confirmed >= REVIEW_PROMPT_RESULTS_THRESHOLD
    ? 'results'
    : 'fallback';
}

/**
 * Whether staff can switch the prompt on for a store. Only Shopify stores are
 * asked, a store that declined is never asked again until staff reset it, and
 * an open switch is left as it is.
 */
export type AdminEnableDecision =
  | 'create'
  | 'already_pending'
  | 'opted_out'
  | 'unsupported_platform';

export function decideAdminEnable(store: {
  platformType: string;
  optedOut: boolean;
  hasPending: boolean;
}): AdminEnableDecision {
  if (store.platformType !== 'shopify') return 'unsupported_platform';
  if (store.optedOut) return 'opted_out';
  if (store.hasPending) return 'already_pending';
  return 'create';
}
