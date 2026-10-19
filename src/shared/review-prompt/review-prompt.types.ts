/** What the embedded card reports: an impression, the CTA click, its result, "Not now". */
export const REVIEW_PROMPT_MERCHANT_ACTIONS = [
  'shown',
  'clicked',
  'result',
  'not_now',
] as const;

export type ReviewPromptMerchantAction =
  (typeof REVIEW_PROMPT_MERCHANT_ACTIONS)[number];

/**
 * The codes Shopify's Reviews API (`shopify.reviews.request()`) returns, plus
 * 'unavailable' when the API is missing or throws.
 */
export const REVIEW_REQUEST_CODES = [
  'success',
  'already-reviewed',
  'annual-limit-reached',
  'cooldown-period',
  'merchant-ineligible',
  'mobile-app',
  'recently-installed',
  'cancelled',
  'already-open',
  'open-in-progress',
  'unavailable',
] as const;

export type ReviewRequestCode = (typeof REVIEW_REQUEST_CODES)[number];

/** Where one store stands with the prompt, whatever the staff switch says. */
export const REVIEW_PROMPT_STATES = [
  'eligible',
  'snoozed',
  'declined',
  'clicked',
  'reviewed_prompted',
  'reviewed',
  'ineligible',
] as const;

export type ReviewPromptState = (typeof REVIEW_PROMPT_STATES)[number];

/** Answers that closed a request before the per-store state existed. */
export type ReviewPromptLegacyAnswer =
  | 'review_clicked'
  | 'snoozed'
  | 'dismissed'
  | 'dont_ask_again';

export type ReviewPromptEvent =
  | 'enabled'
  | 'admin_disabled'
  | 'reset'
  | 'shown'
  | 'clicked'
  | 'result'
  | 'snoozed'
  | 'declined'
  | ReviewPromptLegacyAnswer;

export const REVIEW_PROMPT_REQUEST_STATUSES = [
  'pending',
  'answered',
  'admin_disabled',
] as const;

export type ReviewPromptRequestStatus =
  (typeof REVIEW_PROMPT_REQUEST_STATUSES)[number];

/** How a request was closed: a legacy merchant answer or staff. */
export type ReviewPromptClosedAction =
  | ReviewPromptLegacyAnswer
  | 'admin_disabled';

export type ReviewPromptActorType = 'admin' | 'merchant';

/** The card shows the store's results only once they are worth showing. */
export type ReviewPromptVariant = 'results' | 'fallback';
