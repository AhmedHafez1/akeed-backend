import type { TemplateReviewStatus } from '../../src/shared/messaging/template-provider.types';
import type { RegistryTemplate } from '../../src/shared/messaging/template-registry.types';
import { selectTemplateForSend } from '../../src/shared/messaging/template-selector';
import {
  reminderTemplate,
  syncedApprovedTemplates,
} from '../../src/shared/messaging/testing/seeded-template-registry';

/**
 * US-08-08 criterion 5 as one matrix over the selector every send path
 * calls. The PostgreSQL gate contract proves the same rule through the real
 * send service, ledger and usage accounting; this file walks every status
 * the registry can hold.
 */
const EGYPTIAN = 'cod_confirm.ar.egyptian';
const AR_DEFAULT = 'cod_confirm.ar.standard';
const EG_PHONE = '+201001112223';
const SA_PHONE = '+966500000001';
const GUARDRAIL = { enabled: true };

/** Every status but `approved`: none of them may be sent (record 4.2.5). */
const NOT_SENDABLE: TemplateReviewStatus[] = [
  'pending',
  'rejected',
  'paused',
  'disabled',
  'in_appeal',
  'limit_exceeded',
  'pending_deletion',
  'deleted',
  'archived',
  'flagged',
  'locked',
  'reinstated',
  'unarchived',
  'missing',
  'unknown',
];

function registry(
  changes: Record<string, Partial<RegistryTemplate>> = {},
  extra: RegistryTemplate[] = [],
): RegistryTemplate[] {
  return [
    ...syncedApprovedTemplates().map((template) => ({
      ...template,
      ...changes[template.key],
    })),
    ...extra,
  ];
}

function select(
  templates: RegistryTemplate[],
  params: Partial<Parameters<typeof selectTemplateForSend>[1]> = {},
) {
  return selectTemplateForSend(templates, {
    preferredLanguage: 'ar',
    phoneNumber: EG_PHONE,
    arKey: EGYPTIAN,
    enKey: 'cod_confirm.en.friendly',
    guardrail: GUARDRAIL,
    ...params,
  });
}

describe('US-08-08 guardrail and fallback matrix', () => {
  it('sends the selected template when it is approved and active, with no fallback', () => {
    expect(select(registry())).toEqual({
      template: expect.objectContaining({ variantKey: 'ar.egyptian' }) as never,
      storedKey: EGYPTIAN,
      fallbackReason: undefined,
    });
  });

  it.each(NOT_SENDABLE)(
    'a selected template that is %s falls back to the default with not_approved',
    (reviewStatus) => {
      expect(select(registry({ [EGYPTIAN]: { reviewStatus } }))).toMatchObject({
        template: { variantKey: 'ar.standard' },
        storedKey: EGYPTIAN,
        fallbackReason: 'not_approved',
      });
    },
  );

  it('a selected template the environment has never synced is not approved either, once any row has synced', () => {
    expect(
      select(registry({ [EGYPTIAN]: { reviewStatus: null } })),
    ).toMatchObject({ fallbackReason: 'not_approved' });
  });

  it.each([
    ['missing', { arKey: null }, 'key_missing'],
    ['not in the registry', { arKey: 'cod_confirm.ar.gone' }, 'key_unknown'],
    [
      'written for English',
      { arKey: 'cod_confirm.en.short' },
      'wrong_language',
    ],
  ] as const)(
    'a stored choice that is %s falls back with %s',
    (_case, params, reason) => {
      expect(select(registry(), params)).toMatchObject({
        template: { variantKey: 'ar.standard' },
        fallbackReason: reason,
      });
    },
  );

  it('a selected template that is switched off in Akeed falls back with key_inactive', () => {
    expect(select(registry({ [EGYPTIAN]: { isActive: false } }))).toMatchObject(
      {
        template: { variantKey: 'ar.standard' },
        fallbackReason: 'key_inactive',
      },
    );
  });

  it('a re-categorized template stays sendable: Meta keeps it approved, and it is a staff alert (record 4.5.5 and the 4.5.13 rule)', () => {
    expect(
      select(registry({ [EGYPTIAN]: { category: 'marketing' } })),
    ).toMatchObject({
      template: { variantKey: 'ar.egyptian' },
      fallbackReason: undefined,
    });
  });

  it.each(NOT_SENDABLE)(
    'with the selected template and the default both %s, nothing is selected',
    (reviewStatus) => {
      expect(
        select(
          registry({
            [EGYPTIAN]: { reviewStatus },
            [AR_DEFAULT]: { reviewStatus },
          }),
        ),
      ).toEqual({
        template: null,
        language: 'ar',
        storedKey: EGYPTIAN,
        reason: 'default_unavailable',
      });
    },
  );

  it('never crosses language, and never picks a third template of the same language', () => {
    const templates = registry({
      [EGYPTIAN]: { reviewStatus: 'paused' },
      [AR_DEFAULT]: { reviewStatus: 'paused' },
    });

    // Gulf and short Arabic and every English template are still approved.
    expect(select(templates).template).toBeNull();
    expect(
      select(templates, { preferredLanguage: 'en' }).template,
    ).toMatchObject({ language: 'en' });
  });

  it('applies the same rule to the reminder and to the first send when the reminder switch is off', () => {
    const templates = registry({ [EGYPTIAN]: { reviewStatus: 'disabled' } });

    expect(select(templates, { kind: 'follow_up' })).toEqual(
      select(templates, { kind: 'initial' }),
    );
  });

  describe('US-08-07a reminder fallback', () => {
    const REMINDER = 'cod_reminder.ar.soft_v1';
    const reminder = (change: Partial<RegistryTemplate> = {}) =>
      reminderTemplate('ar', 'soft_v1', {
        lastSyncedAt: '2026-10-05T00:00:00.000Z',
        ...change,
      });
    const params = {
      kind: 'follow_up' as const,
      arReminderKey: REMINDER,
      switches: { reminderTemplate: true },
    };

    it('sends the chosen reminder when it is approved', () => {
      expect(select(registry({}, [reminder()]), params)).toMatchObject({
        template: { templateName: 'akeed_cod_reminder_soft_v1' },
        storedKey: REMINDER,
      });
    });

    it.each(['paused', 'rejected', 'disabled', 'missing'] as const)(
      'a %s reminder with no reminder default falls back to the first-send template with reminder_unavailable',
      (reviewStatus) => {
        expect(
          select(registry({}, [reminder({ reviewStatus })]), params),
        ).toMatchObject({
          template: { variantKey: 'ar.egyptian' },
          storedKey: REMINDER,
          fallbackReason: 'reminder_unavailable',
        });
      },
    );

    it('is skipped when the first-send template and its default are unavailable too', () => {
      expect(
        select(
          registry(
            {
              [EGYPTIAN]: { reviewStatus: 'paused' },
              [AR_DEFAULT]: { reviewStatus: 'paused' },
            },
            [reminder()],
          ),
          params,
        ).template,
      ).toBeNull();
    });

    it('never sends a reminder template on the first send', () => {
      expect(
        select(registry({}, [reminder()]), { ...params, kind: 'initial' }),
      ).toMatchObject({ template: { variantKey: 'ar.egyptian' } });
    });
  });

  describe('US-08-07d auto style fallback', () => {
    const params = {
      arAuto: true,
      switches: { arabicStyleAuto: true },
    };

    it('sends the style the number maps to when it is approved', () => {
      expect(
        select(registry(), { ...params, phoneNumber: EG_PHONE }),
      ).toMatchObject({ template: { variantKey: 'ar.egyptian' } });
      expect(
        select(registry(), { ...params, phoneNumber: SA_PHONE }),
      ).toMatchObject({ template: { variantKey: 'ar.gulf' } });
    });

    it.each(['paused', 'rejected', 'disabled', 'missing'] as const)(
      'falls back to the Arabic default with auto_style_unavailable when the mapped style is %s',
      (reviewStatus) => {
        expect(
          select(registry({ [EGYPTIAN]: { reviewStatus } }), params),
        ).toMatchObject({
          template: { variantKey: 'ar.standard' },
          storedKey: EGYPTIAN,
          fallbackReason: 'auto_style_unavailable',
        });
      },
    );

    it('is skipped when the Arabic default is unavailable too', () => {
      expect(
        select(
          registry({
            [EGYPTIAN]: { reviewStatus: 'paused' },
            [AR_DEFAULT]: { reviewStatus: 'paused' },
          }),
          params,
        ),
      ).toMatchObject({ template: null, reason: 'default_unavailable' });
    });

    it('is ignored while its switch is off: the stored style is used', () => {
      expect(
        select(registry(), {
          arAuto: true,
          arKey: 'cod_confirm.ar.gulf',
          phoneNumber: EG_PHONE,
        }),
      ).toMatchObject({ template: { variantKey: 'ar.gulf' } });
    });
  });
});
