/** The answers a merchant can give the review banner. Each one closes the request. */
export const REVIEW_PROMPT_MERCHANT_ACTIONS = [
  'review_clicked',
  'snoozed',
  'dismissed',
  'dont_ask_again',
] as const;

export type ReviewPromptMerchantAction =
  (typeof REVIEW_PROMPT_MERCHANT_ACTIONS)[number];

export const REVIEW_PROMPT_EVENTS = [
  'enabled',
  'shown',
  ...REVIEW_PROMPT_MERCHANT_ACTIONS,
  'admin_disabled',
] as const;

export type ReviewPromptEvent = (typeof REVIEW_PROMPT_EVENTS)[number];

export const REVIEW_PROMPT_REQUEST_STATUSES = [
  'pending',
  'answered',
  'admin_disabled',
] as const;

export type ReviewPromptRequestStatus =
  (typeof REVIEW_PROMPT_REQUEST_STATUSES)[number];

/** How a request was closed: by one merchant answer or by staff. */
export type ReviewPromptClosedAction =
  | ReviewPromptMerchantAction
  | 'admin_disabled';

export type ReviewPromptActorType = 'admin' | 'merchant';
