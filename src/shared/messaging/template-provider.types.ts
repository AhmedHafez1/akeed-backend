import type { TemplateRejectionReason } from './template-draft.types';
import type { TemplatePurpose } from './template-registry.types';

/**
 * What the provider says about one template, in neutral terms. Only the
 * provider adapter knows the provider's own strings; everything past the port
 * sees these values.
 *
 * Only `approved` may be sent. `flagged`, `locked`, `reinstated` and
 * `unarchived` come from webhooks whose meaning for sending is not known: they
 * are not sendable until a sync reads the template's status again. `missing`
 * is a registry row the provider has no template for. `unknown` is a value
 * the adapter does not recognise.
 */
export type TemplateReviewStatus =
  | 'approved'
  | 'pending'
  | 'rejected'
  | 'paused'
  | 'disabled'
  | 'in_appeal'
  | 'limit_exceeded'
  | 'pending_deletion'
  | 'deleted'
  | 'archived'
  | 'flagged'
  | 'locked'
  | 'reinstated'
  | 'unarchived'
  | 'missing'
  | 'unknown';

export const SENDABLE_REVIEW_STATUS: TemplateReviewStatus = 'approved';

export type TemplateCategory =
  | 'utility'
  | 'marketing'
  | 'authentication'
  | 'unknown';

/** `pending` is a template too new to have a quality score yet. */
export type TemplateQuality = 'high' | 'medium' | 'low' | 'pending' | 'unknown';

export type TemplateButtonKind = 'quick_reply' | 'url' | 'phone' | 'other';

/**
 * The template's text as the provider holds it. `{ unknown: true }` is a
 * response the adapter could not read; it is never compared for drift.
 */
export type TemplateComponentsSnapshot =
  | {
      header?: string;
      body: string;
      footer?: string;
      buttons: { kind: TemplateButtonKind; text: string }[];
    }
  | { unknown: true };

/** One template as the provider lists it. */
export interface ProviderTemplateRecord {
  /** The provider's ID, kept as a string. */
  providerTemplateId: string;
  templateName: string;
  languageCode: string;
  status: TemplateReviewStatus;
  category: TemplateCategory;
  /** A category the provider has said the template will move to. */
  pendingCategory: TemplateCategory | null;
  quality: TemplateQuality;
  components: TemplateComponentsSnapshot;
  /** Why review rejected it; absent when the provider did not say. */
  rejectionReason?: TemplateRejectionReason | null;
}

export type TemplateEventField = 'status' | 'quality' | 'category';

/**
 * One provider notification about a template. `identityKey` is stable across
 * redeliveries of the same notification; `occurredAt` is the provider's own
 * time for it, to the second.
 */
export interface TemplateProviderEvent {
  field: TemplateEventField;
  identityKey: string;
  occurredAt: string;
  templateName: string;
  languageCode: string;
  providerTemplateId: string | null;
  status?: TemplateReviewStatus;
  quality?: TemplateQuality;
  category?: TemplateCategory;
  pendingCategory?: TemplateCategory | null;
  /** On a status event: why review rejected the template, if it did. */
  rejectionReason?: TemplateRejectionReason | null;
}

/**
 * The category each purpose is registered under. A template the provider has
 * moved to another category stays sendable, but staff are alerted.
 */
export const EXPECTED_CATEGORY_BY_PURPOSE: Record<
  TemplatePurpose,
  TemplateCategory
> = {
  cod_confirmation: 'utility',
  cod_reminder: 'utility',
};

export function isSendableReviewStatus(
  status: TemplateReviewStatus | null | undefined,
): boolean {
  return status === SENDABLE_REVIEW_STATUS;
}

/** A registry row as sync and template events see it. */
export interface SyncedTemplateRow {
  id: string;
  key: string;
  purpose: TemplatePurpose;
  isActive: boolean;
  isDefault: boolean;
  templateName: string;
  languageCode: string;
  providerTemplateId: string | null;
  reviewStatus: TemplateReviewStatus | null;
  category: TemplateCategory | null;
  pendingCategory: TemplateCategory | null;
  quality: TemplateQuality | null;
  components: TemplateComponentsSnapshot | null;
  statusEventAt: string | null;
  qualityEventAt: string | null;
  categoryEventAt: string | null;
}

/** The provider-side values a sync or an event writes on a row. */
export interface ProviderState {
  providerTemplateId: string | null;
  reviewStatus: TemplateReviewStatus | null;
  category: TemplateCategory | null;
  pendingCategory: TemplateCategory | null;
  quality: TemplateQuality | null;
  components: TemplateComponentsSnapshot | null;
}
