import type { ProviderTemplateRecord } from '../../shared/messaging/template-provider.types';
import {
  inspected,
  row,
  TEXT,
} from '../../../test/fixtures/whatsapp-connection-setup.fixtures';
import {
  classifyCreateFailure,
  componentsHash,
  driftOf,
  isProvisionable,
  isSubmittable,
  planRowSync,
  provisioningSettled,
  summarizeTemplates,
  templateRetryDelayMs,
} from './template-provisioning.policy';

function record(
  overrides: Partial<ProviderTemplateRecord> = {},
): ProviderTemplateRecord {
  return {
    providerTemplateId: '555',
    templateName: 'akeed_cod_verification_friendly',
    languageCode: 'en',
    status: 'approved',
    category: 'utility',
    pendingCategory: null,
    quality: 'pending',
    components: TEXT,
    ...overrides,
  };
}

const NOW = new Date('2026-11-03T10:00:00.000Z');

describe('isProvisionable', () => {
  const none = new Set<string>();

  it('takes an active, approved, synced text template', () => {
    expect(isProvisionable(inspected(), none)).toBe(true);
  });

  it.each([
    ['inactive', inspected({ isActive: false })],
    ['not approved for Akeed', inspected({ reviewStatus: 'pending' })],
    ['never synced', inspected({}, null)],
    ['unreadable text', inspected({}, { unknown: true })],
  ])('leaves out a template that is %s', (_, template) => {
    expect(isProvisionable(template, none)).toBe(false);
  });

  it('leaves out a retired template', () => {
    expect(
      isProvisionable(inspected(), new Set(['cod_confirm.en.friendly'])),
    ).toBe(false);
  });
});

describe('classifyCreateFailure', () => {
  it('reads code 100 with subcode 2388024 as a duplicate', () => {
    expect(
      classifyCreateFailure({
        ok: false,
        kind: 'rejected',
        graphErrorCode: 100,
        graphErrorSubcode: 2388024,
      }),
    ).toEqual({ kind: 'duplicate' });
  });

  it('reads code 100 without that subcode as a refusal of the text', () => {
    expect(
      classifyCreateFailure({
        ok: false,
        kind: 'rejected',
        graphErrorCode: 100,
      }),
    ).toEqual({ kind: 'rejected', errorCode: 'invalid_parameter' });
  });

  it.each([
    [{ kind: 'timeout' as const, graphErrorCode: null }, 'unresolved'],
    [{ kind: 'unavailable' as const, graphErrorCode: null }, 'unresolved'],
    [{ kind: 'rejected' as const, graphErrorCode: null }, 'unresolved'],
    [{ kind: 'rejected' as const, graphErrorCode: 80008 }, 'rate_limited'],
    [{ kind: 'rejected' as const, graphErrorCode: 190 }, 'credentials'],
    [{ kind: 'rejected' as const, graphErrorCode: 200 }, 'credentials'],
    [{ kind: 'rejected' as const, graphErrorCode: 2388040 }, 'rejected'],
  ])('classifies %o as %s', (failure, kind) => {
    expect(classifyCreateFailure({ ok: false, ...failure }).kind).toBe(kind);
  });
});

describe('drift', () => {
  it('hashes equal text equally, whatever the key order', () => {
    expect(componentsHash(TEXT)).toBe(
      componentsHash({ buttons: TEXT.buttons, body: TEXT.body }),
    );
    expect(componentsHash(TEXT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks a registry edit after submission', () => {
    const edited = { ...TEXT, body: 'Hi {{customer}}, order {{order}}?' };
    expect(
      driftOf({ submittedComponentsHash: componentsHash(TEXT) }, edited, TEXT),
    ).toBe('registry_edited');
  });

  it('marks other text at the provider', () => {
    const other = { ...TEXT, body: 'Something else' };
    expect(driftOf({ submittedComponentsHash: null }, TEXT, other)).toBe(
      'provider_differs',
    );
  });

  it('marks nothing when the text matches, or cannot be read', () => {
    const hash = componentsHash(TEXT);
    expect(driftOf({ submittedComponentsHash: hash }, TEXT, TEXT)).toBeNull();
    expect(
      driftOf({ submittedComponentsHash: null }, TEXT, { unknown: true }),
    ).toBeNull();
  });
});

describe('planRowSync', () => {
  const registry = new Map([['tpl-en', inspected()]]);

  it('takes Meta values for a listed template, matched by exact name and language', () => {
    const [plan] = planRowSync(
      [row({ status: 'pending', metaTemplateId: '555' })],
      [record(), record({ languageCode: 'ar', providerTemplateId: '556' })],
      registry,
      NOW,
    );
    expect(plan.patch).toMatchObject({
      metaTemplateId: '555',
      status: 'approved',
      category: 'utility',
      lastSyncedAt: 'now',
    });
    expect(plan.patch).not.toHaveProperty('driftReason');
  });

  it('matches a template whose language code uses a dash', () => {
    const egyptian = new Map([
      [
        'tpl-eg',
        inspected({ id: 'tpl-eg', languageCode: 'ar_EG', language: 'ar' }),
      ],
    ]);
    const [plan] = planRowSync(
      [row({ templateId: 'tpl-eg', metaLanguageCode: 'ar_EG' })],
      [record({ languageCode: 'ar_EG', providerTemplateId: '777' })],
      egyptian,
      NOW,
    );
    expect(plan.patch).toMatchObject({ metaTemplateId: '777' });
  });

  it('marks a template Meta stopped listing as missing', () => {
    const [plan] = planRowSync(
      [row({ status: 'approved', metaTemplateId: '555' })],
      [],
      registry,
      NOW,
    );
    expect(plan.patch).toMatchObject({
      status: 'missing',
      metaTemplateId: null,
    });
  });

  it('turns an unresolved create Meta does not list into a due retry', () => {
    const [plan] = planRowSync(
      [row({ status: 'unresolved' })],
      [],
      registry,
      NOW,
    );
    expect(plan.patch).toMatchObject({
      status: 'failed',
      lastErrorCode: 'not_created',
      nextAttemptAt: NOW.toISOString(),
    });
  });

  it('adopts an unresolved create Meta does list', () => {
    const [plan] = planRowSync(
      [row({ status: 'unresolved' })],
      [record({ status: 'pending' })],
      registry,
      NOW,
    );
    expect(plan.patch).toMatchObject({
      status: 'pending',
      metaTemplateId: '555',
    });
  });

  it('leaves a submission still under its lease alone', () => {
    const [plan] = planRowSync(
      [row({ status: 'submitting', leaseUntil: '2026-11-03T10:01:00.000Z' })],
      [],
      registry,
      NOW,
    );
    expect(plan.patch).toBeNull();
  });

  it('marks drift once and keeps the first mark', () => {
    const edited = new Map([
      [
        'tpl-en',
        inspected({}, { ...TEXT, body: 'Edited {{customer}} {{order}}' }),
      ],
    ]);
    const first = planRowSync(
      [
        row({
          status: 'approved',
          submittedComponentsHash: componentsHash(TEXT),
        }),
      ],
      [record()],
      edited,
      NOW,
    );
    expect(first[0].patch).toMatchObject({
      driftAt: 'now',
      driftReason: 'registry_edited',
    });
    const again = planRowSync(
      [
        row({
          status: 'approved',
          driftAt: NOW.toISOString(),
          driftReason: 'registry_edited',
        }),
      ],
      [record()],
      edited,
      NOW,
    );
    expect(again[0].patch).not.toHaveProperty('driftReason');
  });
});

describe('submission state', () => {
  it('sends only what was never sent, failed and is due, or went missing', () => {
    expect(isSubmittable(row(), NOW)).toBe(true);
    expect(isSubmittable(row({ status: 'missing' }), NOW)).toBe(true);
    expect(
      isSubmittable(
        row({ status: 'failed', nextAttemptAt: '2026-11-03T09:00:00.000Z' }),
        NOW,
      ),
    ).toBe(true);
    expect(
      isSubmittable(
        row({ status: 'failed', nextAttemptAt: '2026-11-03T11:00:00.000Z' }),
        NOW,
      ),
    ).toBe(false);
    for (const status of [
      'submitting',
      'unresolved',
      'pending',
      'approved',
      'rejected',
      'exhausted',
      'incompatible',
    ])
      expect(isSubmittable(row({ status }), NOW)).toBe(false);
  });

  it('is settled only when nothing waits on a submission or an answer', () => {
    expect(
      provisioningSettled([
        row({ status: 'pending' }),
        row({ status: 'exhausted' }),
      ]),
    ).toBe(true);
    for (const status of [
      'not_submitted',
      'submitting',
      'unresolved',
      'failed',
      'missing',
    ])
      expect(provisioningSettled([row({ status })])).toBe(false);
  });

  it('backs off and caps the delay', () => {
    expect(templateRetryDelayMs(1)).toBe(60_000);
    expect(templateRetryDelayMs(2)).toBe(5 * 60_000);
    expect(templateRetryDelayMs(99)).toBe(6 * 60 * 60_000);
  });
});

describe('summarizeTemplates', () => {
  it('counts ready only for approved UTILITY templates', () => {
    expect(
      summarizeTemplates([
        row({ status: 'approved', category: 'utility' }),
        row({ status: 'approved', category: 'marketing' }),
        row({ status: 'pending' }),
        row({ status: 'rejected' }),
        row({ status: 'paused', category: 'utility' }),
        row({ status: 'failed' }),
        row({ status: 'exhausted' }),
        row({ status: 'incompatible', driftAt: NOW.toISOString() }),
      ]),
    ).toEqual({
      total: 8,
      ready: 1,
      pending: 1,
      rejected: 1,
      recategorized: 1,
      retrying: 1,
      needsStaff: 2,
      drift: 1,
    });
  });
});
