import {
  EXPECTED_CATEGORY_BY_PURPOSE,
  isSendableReviewStatus,
  type ProviderState,
  type ProviderTemplateRecord,
  type SyncedTemplateRow,
  type TemplateCategory,
  type TemplateComponentsSnapshot,
  type TemplateEventField,
  type TemplateProviderEvent,
} from '../../shared/messaging/template-provider.types';
import type { TemplatePurpose } from '../../shared/messaging/template-registry.types';

export type { ProviderState, SyncedTemplateRow };

export function providerState(row: SyncedTemplateRow): ProviderState {
  return {
    providerTemplateId: row.providerTemplateId,
    reviewStatus: row.reviewStatus,
    category: row.category,
    pendingCategory: row.pendingCategory,
    quality: row.quality,
    components: row.components,
  };
}

/** Name and language as one key, with `-` and `_` read alike (4.8.16). */
export function templateIdentity(name: string, languageCode: string): string {
  return `${name}\u0000${languageCode.trim().replaceAll('-', '_')}`;
}

/** JSON with sorted keys, so two equal values always compare equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function isReadable(
  snapshot: TemplateComponentsSnapshot | null,
): snapshot is Exclude<TemplateComponentsSnapshot, { unknown: true }> {
  return snapshot !== null && !('unknown' in snapshot);
}

/**
 * The provider's text changed since the last snapshot. Never true when either
 * side could not be read: an unreadable response is not a text change.
 */
export function hasTextDrift(
  previous: TemplateComponentsSnapshot | null,
  next: TemplateComponentsSnapshot | null,
): boolean {
  return (
    isReadable(previous) &&
    isReadable(next) &&
    canonicalJson(previous) !== canonicalJson(next)
  );
}

export function sameProviderState(
  left: ProviderState,
  right: ProviderState,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export interface SyncRowPlan {
  row: SyncedTemplateRow;
  next: ProviderState;
  changed: boolean;
  drift: boolean;
}

export interface SyncPlan {
  rows: SyncRowPlan[];
  missingKeys: string[];
  unknownAtProvider: { templateName: string; languageCode: string }[];
}

/**
 * What a sync does to each registry row. A row is matched by provider name and
 * language code; a row with no provider template becomes `missing` and keeps
 * its other values; a provider template with no row is reported only.
 */
export function planSync(
  rows: readonly SyncedTemplateRow[],
  records: readonly ProviderTemplateRecord[],
): SyncPlan {
  const byIdentity = new Map<string, ProviderTemplateRecord>();
  for (const record of records) {
    byIdentity.set(
      templateIdentity(record.templateName, record.languageCode),
      record,
    );
  }
  const matched = new Set<string>();
  const planned = rows.map((row): SyncRowPlan => {
    const identity = templateIdentity(row.templateName, row.languageCode);
    const record = byIdentity.get(identity);
    const current = providerState(row);
    if (!record) {
      const next: ProviderState = { ...current, reviewStatus: 'missing' };
      return {
        row,
        next,
        changed: !sameProviderState(current, next),
        drift: false,
      };
    }
    matched.add(identity);
    const next: ProviderState = {
      providerTemplateId: record.providerTemplateId,
      reviewStatus: record.status,
      category: record.category,
      pendingCategory: record.pendingCategory,
      quality: record.quality,
      components: record.components,
    };
    return {
      row,
      next,
      changed: !sameProviderState(current, next),
      drift: hasTextDrift(row.components, record.components),
    };
  });
  return {
    rows: planned,
    missingKeys: planned
      .filter((plan) => plan.next.reviewStatus === 'missing')
      .map((plan) => plan.row.key),
    unknownAtProvider: records
      .filter(
        (record) =>
          !matched.has(
            templateIdentity(record.templateName, record.languageCode),
          ),
      )
      .map(({ templateName, languageCode }) => ({
        templateName,
        languageCode,
      })),
  };
}

export type EventOutcome = 'applied' | 'stale' | 'conflict';

const EVENT_AT: Record<TemplateEventField, keyof SyncedTemplateRow> = {
  status: 'statusEventAt',
  quality: 'qualityEventAt',
  category: 'categoryEventAt',
};

/** The row's values with one event applied. */
export function applyEventValue(
  state: ProviderState,
  event: TemplateProviderEvent,
): ProviderState {
  switch (event.field) {
    case 'status':
      return { ...state, reviewStatus: event.status ?? 'unknown' };
    case 'quality':
      return { ...state, quality: event.quality ?? 'unknown' };
    case 'category':
      return {
        ...state,
        category: event.category ?? 'unknown',
        pendingCategory: event.pendingCategory ?? null,
      };
  }
}

/**
 * Whether an event may change a row (record 4.8, "Order"). Only an event
 * later than the newest one applied for that field is applied. An earlier one
 * is stale. One in the same second that would change the row is a conflict:
 * it is not ordered by guesswork, and the caller asks for a sync instead.
 */
export function decideEvent(
  row: SyncedTemplateRow,
  event: TemplateProviderEvent,
): { outcome: EventOutcome; next: ProviderState } {
  const current = providerState(row);
  const next = applyEventValue(current, event);
  const appliedAt = row[EVENT_AT[event.field]] as string | null;
  if (!appliedAt) return { outcome: 'applied', next };
  const incoming = Date.parse(event.occurredAt);
  const applied = Date.parse(appliedAt);
  if (incoming > applied) return { outcome: 'applied', next };
  if (incoming === applied && !sameProviderState(current, next)) {
    return { outcome: 'conflict', next: current };
  }
  return { outcome: 'stale', next: current };
}

export const EVENT_AT_COLUMN = EVENT_AT;

/** Healthy as far as the provider is concerned: approved, or not read yet. */
export function isProviderSendable(state: ProviderState): boolean {
  return (
    state.reviewStatus === null || isSendableReviewStatus(state.reviewStatus)
  );
}

/** The provider has moved, or will move, the template out of its category. */
export function isRecategorized(
  purpose: TemplatePurpose,
  state: ProviderState,
): boolean {
  const expected = EXPECTED_CATEGORY_BY_PURPOSE[purpose];
  const differs = (category: TemplateCategory | null) =>
    category !== null && category !== 'unknown' && category !== expected;
  return differs(state.category) || differs(state.pendingCategory);
}
