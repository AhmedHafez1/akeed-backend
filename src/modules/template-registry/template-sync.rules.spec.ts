import type {
  ProviderTemplateRecord,
  SyncedTemplateRow,
  TemplateProviderEvent,
} from '../../shared/messaging/template-provider.types';
import { seededSyncRows } from './testing/in-memory-template-sync.repository';
import {
  canonicalJson,
  decideEvent,
  hasTextDrift,
  isRecategorized,
  planSync,
  providerState,
} from './template-sync.rules';

function record(
  name: string,
  languageCode: string,
  change: Partial<ProviderTemplateRecord> = {},
): ProviderTemplateRecord {
  return {
    providerTemplateId: '1',
    templateName: name,
    languageCode,
    status: 'approved',
    category: 'utility',
    pendingCategory: null,
    quality: 'high',
    components: { body: 'b', buttons: [] },
    ...change,
  };
}

function event(change: Partial<TemplateProviderEvent>): TemplateProviderEvent {
  return {
    field: 'status',
    identityKey: 'k',
    occurredAt: '2026-01-01T00:00:10.000Z',
    templateName: 'akeed_cod_verification_friendly',
    languageCode: 'ar',
    providerTemplateId: '1',
    status: 'paused',
    ...change,
  };
}

describe('template sync rules', () => {
  it('matches a provider template whose language code uses - against a row using _', () => {
    const rows = seededSyncRows();

    const plan = planSync(rows, [
      record('akeed_cod_verification_direct_eg', 'ar-EG'),
    ]);

    expect(
      plan.rows.find((entry) => entry.row.key === 'cod_confirm.ar.egyptian')
        ?.next.reviewStatus,
    ).toBe('approved');
    expect(plan.missingKeys).toHaveLength(7);
    expect(plan.unknownAtProvider).toEqual([]);
  });

  it('compares snapshots without regard to key order, and never across an unknown one', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
    expect(
      hasTextDrift({ body: 'a', buttons: [] }, { body: 'b', buttons: [] }),
    ).toBe(true);
    expect(hasTextDrift(null, { body: 'b', buttons: [] })).toBe(false);
    expect(hasTextDrift({ unknown: true }, { body: 'b', buttons: [] })).toBe(
      false,
    );
  });

  it('applies a later event, ignores an earlier one, and calls a same-second change a conflict', () => {
    const row: SyncedTemplateRow = {
      ...seededSyncRows()[0],
      reviewStatus: 'approved',
      statusEventAt: '2026-01-01T00:00:10.000Z',
    };

    expect(
      decideEvent(row, event({ occurredAt: '2026-01-01T00:00:11.000Z' })),
    ).toMatchObject({ outcome: 'applied', next: { reviewStatus: 'paused' } });
    expect(
      decideEvent(row, event({ occurredAt: '2026-01-01T00:00:09.000Z' })),
    ).toEqual({ outcome: 'stale', next: providerState(row) });
    expect(decideEvent(row, event({}))).toEqual({
      outcome: 'conflict',
      next: providerState(row),
    });
    expect(decideEvent(row, event({ status: 'approved' }))).toMatchObject({
      outcome: 'stale',
    });
  });

  it('treats a category other than the registered one, now or coming, as a re-categorization', () => {
    const state = providerState(seededSyncRows()[0]);

    expect(isRecategorized('cod_confirmation', state)).toBe(false);
    expect(
      isRecategorized('cod_confirmation', { ...state, category: 'marketing' }),
    ).toBe(true);
    expect(
      isRecategorized('cod_confirmation', {
        ...state,
        category: 'utility',
        pendingCategory: 'marketing',
      }),
    ).toBe(true);
    expect(
      isRecategorized('cod_confirmation', { ...state, category: 'unknown' }),
    ).toBe(false);
  });
});
