/**
 * Stable error codes for tips and updates. The admin and merchant screens
 * translate by code, so never rename one.
 */
export const TIPS_CAMPAIGN_ERROR_CODES = {
  notFound: 'TIPS_CAMPAIGN_NOT_FOUND',
  invalid: 'TIPS_CAMPAIGN_INVALID',
  revisionConflict: 'TIPS_CAMPAIGN_REVISION_CONFLICT',
  notEditable: 'TIPS_CAMPAIGN_NOT_EDITABLE',
  audienceLocked: 'TIPS_CAMPAIGN_AUDIENCE_LOCKED',
  expiryLocked: 'TIPS_CAMPAIGN_EXPIRY_LOCKED',
  invalidTransition: 'TIPS_CAMPAIGN_INVALID_TRANSITION',
  expired: 'TIPS_CAMPAIGN_EXPIRED',
  noRecipients: 'TIPS_CAMPAIGN_NO_RECIPIENTS',
  audienceTooLarge: 'TIPS_CAMPAIGN_AUDIENCE_TOO_LARGE',
  reviewRequired: 'TIPS_CAMPAIGN_REVIEW_REQUIRED',
  audienceChanged: 'TIPS_CAMPAIGN_AUDIENCE_CHANGED',
  cardNotFound: 'TIPS_CARD_NOT_FOUND',
  dismissForbidden: 'TIPS_DISMISS_FORBIDDEN',
} as const;

export type TipsCampaignErrorCode =
  (typeof TIPS_CAMPAIGN_ERROR_CODES)[keyof typeof TIPS_CAMPAIGN_ERROR_CODES];
