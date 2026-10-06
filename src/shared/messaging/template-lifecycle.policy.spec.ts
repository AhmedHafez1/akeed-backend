import {
  decideEdit,
  decideLifecycle,
  isEligibleReplacement,
  type LifecycleTemplate,
} from './template-lifecycle.policy';

function template(
  key: string,
  overrides: Partial<LifecycleTemplate> = {},
): LifecycleTemplate {
  return {
    id: `id-${key}`,
    key,
    purpose: 'cod_confirmation',
    language: 'ar',
    isActive: true,
    isDefault: false,
    reviewStatus: 'approved',
    retiredAt: null,
    ...overrides,
  };
}

const standard = template('cod_confirm.ar.standard', { isDefault: true });
const egyptian = template('cod_confirm.ar.egyptian');
const fresh = template('cod_confirm.ar.warm_v1', { isActive: false });
const scope = [egyptian, standard, fresh];

function decide(
  action: Parameters<typeof decideLifecycle>[0]['action'],
  target: LifecycleTemplate,
  extra: { replacement?: LifecycleTemplate; storeCount?: number } = {},
) {
  return decideLifecycle({
    action,
    target,
    scope,
    replacement: extra.replacement ?? null,
    storeCount: extra.storeCount ?? 0,
  });
}

describe('template lifecycle rules (US-08-06 criteria 6 and 7)', () => {
  describe('activate', () => {
    it('activates an approved template', () => {
      expect(decide('activate', fresh)).toEqual({
        ok: true,
        changes: [{ id: fresh.id, isActive: true }],
        moveStoresTo: null,
      });
    });

    it.each(['pending', 'rejected', 'paused', 'missing', null] as const)(
      'refuses a template whose review status is %p',
      (reviewStatus) => {
        expect(decide('activate', { ...fresh, reviewStatus })).toEqual({
          ok: false,
          reason: 'not_approved',
        });
      },
    );

    it('changes nothing for a template already active', () => {
      expect(decide('activate', egyptian)).toEqual({
        ok: true,
        changes: [],
        moveStoresTo: null,
      });
    });
  });

  describe('set default', () => {
    it('unsets the current default before it sets the new one', () => {
      expect(decide('set_default', egyptian)).toEqual({
        ok: true,
        changes: [
          { id: standard.id, isDefault: false },
          { id: egyptian.id, isDefault: true },
        ],
        moveStoresTo: null,
      });
    });

    it('refuses an inactive or unapproved template', () => {
      expect(decide('set_default', fresh)).toEqual({
        ok: false,
        reason: 'not_active',
      });
      expect(
        decide('set_default', { ...egyptian, reviewStatus: 'paused' }),
      ).toEqual({ ok: false, reason: 'not_approved' });
    });

    it('changes nothing for the current default', () => {
      expect(decide('set_default', standard)).toEqual({
        ok: true,
        changes: [],
        moveStoresTo: null,
      });
    });
  });

  describe.each(['deactivate', 'retire'] as const)('%s', (action) => {
    const retired = action === 'retire' ? { retired: true } : {};

    it('needs no replacement when no store sends it and it is not a default', () => {
      expect(decide(action, egyptian)).toEqual({
        ok: true,
        changes: [
          { id: egyptian.id, isActive: false, isDefault: false, ...retired },
        ],
        moveStoresTo: null,
      });
    });

    it('is refused while a store sends it and no replacement is named', () => {
      expect(decide(action, egyptian, { storeCount: 12 })).toEqual({
        ok: false,
        reason: 'replacement_required',
      });
    });

    it('is refused for a language default with no replacement, even unused', () => {
      expect(decide(action, standard)).toEqual({
        ok: false,
        reason: 'replacement_required',
      });
    });

    it('moves the stores to the replacement', () => {
      expect(
        decide(action, egyptian, { storeCount: 12, replacement: standard }),
      ).toEqual({
        ok: true,
        changes: [
          { id: egyptian.id, isActive: false, isDefault: false, ...retired },
        ],
        moveStoresTo: standard,
      });
    });

    it('hands the default to the replacement, after it is taken off the target', () => {
      expect(decide(action, standard, { replacement: egyptian })).toEqual({
        ok: true,
        changes: [
          { id: standard.id, isActive: false, isDefault: false, ...retired },
          { id: egyptian.id, isDefault: true },
        ],
        moveStoresTo: egyptian,
      });
    });

    it.each([
      ['itself', egyptian],
      ['an inactive template', fresh],
      [
        'an unapproved template',
        { ...standard, reviewStatus: 'paused' as const },
      ],
      [
        'a retired template',
        { ...standard, retiredAt: '2026-10-01T00:00:00Z' },
      ],
      ['another language', { ...standard, language: 'en' as const }],
    ])('refuses %s as the replacement', (_case, replacement) => {
      expect(decide(action, egyptian, { storeCount: 1, replacement })).toEqual({
        ok: false,
        reason: 'replacement_invalid',
      });
      expect(isEligibleReplacement(egyptian, replacement)).toBe(false);
    });
  });

  it('changes nothing when an inactive template is deactivated', () => {
    expect(decide('deactivate', fresh)).toEqual({
      ok: true,
      changes: [],
      moveStoresTo: null,
    });
  });

  it.each(['activate', 'deactivate', 'set_default', 'retire'] as const)(
    'refuses to %s a retired template',
    (action) => {
      expect(
        decide(action, { ...fresh, retiredAt: '2026-10-01T00:00:00Z' }),
      ).toEqual({ ok: false, reason: 'retired' });
    },
  );
});

describe('template edit rules (US-08-06 criterion 5)', () => {
  const unused = {
    isActive: false,
    isDefault: false,
    reviewStatus: 'approved' as const,
    retiredAt: null,
  };
  const base = {
    target: unused,
    hasDraft: true,
    storeCount: 0,
    editsLastDay: 0,
    editsLast30Days: 0,
  };

  it.each(['approved', 'rejected', 'paused'] as const)(
    '4.3.1: allows an edit of a %s template nothing sends',
    (reviewStatus) => {
      expect(
        decideEdit({ ...base, target: { ...unused, reviewStatus } }),
      ).toEqual({ ok: true });
    },
  );

  it.each(['pending', 'disabled', 'in_appeal', 'missing', null] as const)(
    '4.3.1: refuses an edit while the status is %p',
    (reviewStatus) => {
      expect(
        decideEdit({ ...base, target: { ...unused, reviewStatus } }),
      ).toEqual({ ok: false, reason: 'status_not_editable', rule: '4.3.1' });
    },
  );

  it.each([
    ['active', { target: { ...unused, isActive: true } }],
    ['a default', { target: { ...unused, isActive: true, isDefault: true } }],
    ['selected by a store', { storeCount: 1 }],
  ])(
    '4.3.9: refuses an edit in place of a template that is %s',
    (_case, extra) => {
      expect(decideEdit({ ...base, ...extra })).toEqual({
        ok: false,
        reason: 'in_use',
        rule: '4.3.9',
      });
    },
  );

  it('4.3.2: refuses the second edit of an approved template in 24 hours', () => {
    expect(
      decideEdit({ ...base, editsLastDay: 1, editsLast30Days: 1 }),
    ).toEqual({
      ok: false,
      reason: 'daily_limit',
      rule: '4.3.2',
    });
  });

  it('4.3.2: allows the tenth edit in 30 days and refuses the eleventh', () => {
    expect(decideEdit({ ...base, editsLast30Days: 9 })).toEqual({ ok: true });
    expect(decideEdit({ ...base, editsLast30Days: 10 })).toEqual({
      ok: false,
      reason: 'monthly_limit',
      rule: '4.3.2',
    });
  });

  it('4.3.2: does not limit a rejected or paused template', () => {
    for (const reviewStatus of ['rejected', 'paused'] as const) {
      expect(
        decideEdit({
          ...base,
          target: { ...unused, reviewStatus },
          editsLastDay: 5,
          editsLast30Days: 40,
        }),
      ).toEqual({ ok: true });
    }
  });

  it('refuses a retired template and one Akeed holds no text for', () => {
    expect(
      decideEdit({
        ...base,
        target: { ...unused, retiredAt: '2026-10-01T00:00:00Z' },
      }),
    ).toMatchObject({ ok: false, reason: 'retired' });
    expect(decideEdit({ ...base, hasDraft: false })).toMatchObject({
      ok: false,
      reason: 'not_authored_here',
    });
  });
});
