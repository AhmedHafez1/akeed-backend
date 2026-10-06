import {
  isSendableReviewStatus,
  type TemplateReviewStatus,
} from './template-provider.types';
import type {
  TemplateLanguage,
  TemplatePurpose,
} from './template-registry.types';

/**
 * The rules for the staff actions on a registry template (US-08-06 criteria
 * 5 to 7). Pure: the caller reads the rows under a lock, asks here what to
 * do, and writes the answer in the same transaction.
 */

export type TemplateLifecycleAction =
  | 'activate'
  | 'deactivate'
  | 'set_default'
  | 'retire';

/** A registry row as the lifecycle rules see it. */
export interface LifecycleTemplate {
  id: string;
  key: string;
  purpose: TemplatePurpose;
  language: TemplateLanguage;
  isActive: boolean;
  isDefault: boolean;
  reviewStatus: TemplateReviewStatus | null;
  retiredAt: string | null;
}

export type TemplateLifecycleRefusal =
  | 'retired'
  | 'not_approved'
  | 'not_active'
  | 'replacement_required'
  | 'replacement_invalid';

export interface LifecycleRowChange {
  id: string;
  isActive?: boolean;
  isDefault?: boolean;
  retired?: boolean;
}

export type TemplateLifecycleDecision =
  | { ok: false; reason: TemplateLifecycleRefusal }
  | {
      ok: true;
      /** In write order: a default is always unset before another is set. */
      changes: LifecycleRowChange[];
      /** Move the stores that send the target to the replacement. */
      moveStoresTo: LifecycleTemplate | null;
    };

/** Same purpose and language, approved, active, not retired, not itself. */
export function isEligibleReplacement(
  target: LifecycleTemplate,
  candidate: LifecycleTemplate,
): boolean {
  return (
    candidate.id !== target.id &&
    candidate.purpose === target.purpose &&
    candidate.language === target.language &&
    candidate.isActive &&
    candidate.retiredAt === null &&
    isSendableReviewStatus(candidate.reviewStatus)
  );
}

/**
 * Whether taking a template out of use needs a replacement: a store selects
 * it, or it is the language default (criterion 7).
 */
export function needsReplacement(
  target: Pick<LifecycleTemplate, 'isDefault'>,
  storeCount: number,
): boolean {
  return target.isDefault || storeCount > 0;
}

function withdraw(
  target: LifecycleTemplate,
  replacement: LifecycleTemplate | null,
  storeCount: number,
  retire: boolean,
): TemplateLifecycleDecision {
  const needed = needsReplacement(target, storeCount);
  if (needed && !replacement) {
    return { ok: false, reason: 'replacement_required' };
  }
  if (replacement && !isEligibleReplacement(target, replacement)) {
    return { ok: false, reason: 'replacement_invalid' };
  }
  const changes: LifecycleRowChange[] = [
    {
      id: target.id,
      isActive: false,
      isDefault: false,
      ...(retire ? { retired: true } : {}),
    },
  ];
  if (target.isDefault && replacement && !replacement.isDefault) {
    changes.push({ id: replacement.id, isDefault: true });
  }
  return {
    ok: true,
    changes,
    moveStoresTo: needed ? replacement : null,
  };
}

/**
 * What one action does. `scope` is every template of the target's purpose
 * and language, read under the lock; `storeCount` is how many stores select
 * the target.
 */
export function decideLifecycle(params: {
  action: TemplateLifecycleAction;
  target: LifecycleTemplate;
  scope: readonly LifecycleTemplate[];
  replacement: LifecycleTemplate | null;
  storeCount: number;
}): TemplateLifecycleDecision {
  const { action, target, scope, replacement, storeCount } = params;
  if (target.retiredAt !== null) return { ok: false, reason: 'retired' };
  switch (action) {
    case 'activate':
      if (!isSendableReviewStatus(target.reviewStatus)) {
        return { ok: false, reason: 'not_approved' };
      }
      return {
        ok: true,
        changes: target.isActive ? [] : [{ id: target.id, isActive: true }],
        moveStoresTo: null,
      };
    case 'set_default': {
      if (!isSendableReviewStatus(target.reviewStatus)) {
        return { ok: false, reason: 'not_approved' };
      }
      if (!target.isActive) return { ok: false, reason: 'not_active' };
      if (target.isDefault)
        return { ok: true, changes: [], moveStoresTo: null };
      return {
        ok: true,
        changes: [
          ...scope
            .filter((row) => row.isDefault && row.id !== target.id)
            .map((row) => ({ id: row.id, isDefault: false })),
          { id: target.id, isDefault: true },
        ],
        moveStoresTo: null,
      };
    }
    case 'deactivate':
      if (!target.isActive) {
        return { ok: true, changes: [], moveStoresTo: null };
      }
      return withdraw(target, replacement, storeCount, false);
    case 'retire':
      return withdraw(target, replacement, storeCount, true);
  }
}

/** Record 4.3.2: an approved template's edits, counted by Akeed (4.3.10). */
export const APPROVED_EDIT_LIMIT_PER_DAY = 1;
export const APPROVED_EDIT_LIMIT_PER_30_DAYS = 10;
export const EDIT_DAY_WINDOW_MS = 24 * 60 * 60_000;
export const EDIT_MONTH_WINDOW_MS = 30 * EDIT_DAY_WINDOW_MS;

/** Record 4.3.1: the only statuses an edit is accepted in. */
const EDITABLE_STATUSES: readonly TemplateReviewStatus[] = [
  'approved',
  'rejected',
  'paused',
];

export type TemplateEditRefusal =
  | 'retired'
  | 'not_authored_here'
  | 'status_not_editable'
  | 'in_use'
  | 'daily_limit'
  | 'monthly_limit';

/**
 * Whether a template may be edited now, and the record rule that says no.
 *
 * - 4.3.1: only approved, rejected or paused.
 * - 4.3.9 worst case: a template stores can send is never edited in place,
 *   so it must be inactive, not a default and selected by no store.
 * - 4.3.2 and 4.3.10: an approved template gets one edit in 24 hours and ten
 *   in 30 days, in rolling windows counted from Akeed's own record. A
 *   rejected or paused template has no limit.
 */
export function decideEdit(params: {
  target: Pick<
    LifecycleTemplate,
    'isActive' | 'isDefault' | 'reviewStatus' | 'retiredAt'
  >;
  hasDraft: boolean;
  storeCount: number;
  editsLastDay: number;
  editsLast30Days: number;
}): { ok: true } | { ok: false; reason: TemplateEditRefusal; rule: string } {
  const { target } = params;
  if (target.retiredAt !== null) {
    return { ok: false, reason: 'retired', rule: 'akeed' };
  }
  if (!params.hasDraft) {
    return { ok: false, reason: 'not_authored_here', rule: 'akeed' };
  }
  if (
    !target.reviewStatus ||
    !EDITABLE_STATUSES.includes(target.reviewStatus)
  ) {
    return { ok: false, reason: 'status_not_editable', rule: '4.3.1' };
  }
  if (target.isActive || target.isDefault || params.storeCount > 0) {
    return { ok: false, reason: 'in_use', rule: '4.3.9' };
  }
  if (target.reviewStatus === 'approved') {
    if (params.editsLastDay >= APPROVED_EDIT_LIMIT_PER_DAY) {
      return { ok: false, reason: 'daily_limit', rule: '4.3.2' };
    }
    if (params.editsLast30Days >= APPROVED_EDIT_LIMIT_PER_30_DAYS) {
      return { ok: false, reason: 'monthly_limit', rule: '4.3.2' };
    }
  }
  return { ok: true };
}
