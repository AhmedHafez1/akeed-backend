import { BILLING_PLAN_IDS } from '../billing/billing-plan';
import type { InterfaceLocale } from '../i18n/interface-locales';
import type { TipActionRoute } from './tip-action-routes';

export const TIPS_CAMPAIGN_TYPES = ['tip', 'update'] as const;
export type TipsCampaignType = (typeof TIPS_CAMPAIGN_TYPES)[number];

/** Stored lifecycle. "Expired" is never stored: it is read from `expires_at`. */
export const TIPS_CAMPAIGN_STATUSES = [
  'draft',
  'published',
  'paused',
  'archived',
] as const;
export type TipsCampaignStatus = (typeof TIPS_CAMPAIGN_STATUSES)[number];
export type TipsCampaignEffectiveStatus = TipsCampaignStatus | 'expired';

export const TIPS_LIFECYCLE_ACTIONS = [
  'publish',
  'pause',
  'resume',
  'archive',
] as const;
export type TipsLifecycleAction = (typeof TIPS_LIFECYCLE_ACTIONS)[number];

export const TIPS_TARGETING_MODES = ['direct', 'filters'] as const;
export type TipsTargetingMode = (typeof TIPS_TARGETING_MODES)[number];

/** Platforms with a real spoke; `salla` and `zid` exist only in a check. */
export const TIPS_AUDIENCE_PLATFORMS = [
  'shopify',
  'standalone',
  'easyorders',
  'woocommerce',
] as const;
export type TipsAudiencePlatform = (typeof TIPS_AUDIENCE_PLATFORMS)[number];

/** Shopify plan ids, plus `prepaid` for the sources metered by credits. */
export const TIPS_AUDIENCE_PLANS = [...BILLING_PLAN_IDS, 'prepaid'] as const;
export type TipsAudiencePlan = (typeof TIPS_AUDIENCE_PLANS)[number];

/** The store's WhatsApp message language setting (`default_language`). */
export const TIPS_AUDIENCE_MESSAGE_LANGUAGES = [
  'ar',
  'en',
  'ur',
  'es',
  'fr',
  'tr',
  'auto',
] as const;
export type TipsAudienceMessageLanguage =
  (typeof TIPS_AUDIENCE_MESSAGE_LANGUAGES)[number];

/**
 * Store settings an audience may require on or off. The repository maps each
 * key to one `integrations` column; no column name ever comes from input.
 */
export const TIPS_AUDIENCE_FEATURES = [
  'auto_cancel',
  'quiet_hours',
  'follow_up',
  'escalation',
  'auto_verify',
  'logo_header',
] as const;
export type TipsAudienceFeature = (typeof TIPS_AUDIENCE_FEATURES)[number];

/**
 * Filters combine with AND; the values inside one filter combine with OR. A
 * filter that is absent or empty imposes nothing. Signup dates are whole UTC
 * days, both ends inclusive.
 */
export interface TipsAudienceFilters {
  countries?: string[];
  platforms?: TipsAudiencePlatform[];
  signup_from?: string;
  signup_to?: string;
  message_languages?: TipsAudienceMessageLanguage[];
  plans?: TipsAudiencePlan[];
  features?: Partial<Record<TipsAudienceFeature, boolean>>;
}

export interface TipsAudience {
  mode: TipsTargetingMode;
  filters: TipsAudienceFilters;
  selectedOrgIds: string[];
  excludedOrgIds: string[];
}

export type TipsCampaignAction =
  | { kind: 'internal'; route: TipActionRoute }
  | { kind: 'external'; url: string };

export interface TipsTranslation {
  locale: InterfaceLocale;
  title: string;
  description: string;
  action_label: string | null;
}

export interface TipsValidationIssue {
  field: string;
  code: string;
  locale?: string;
}
