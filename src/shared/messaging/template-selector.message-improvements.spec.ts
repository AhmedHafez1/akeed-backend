import {
  reminderTemplate,
  seededRegistryTemplates,
  syncedApprovedTemplates,
} from './testing/seeded-template-registry';
import {
  findSendableByStyle,
  selectTemplateForSend,
} from './template-selector';
import type { RegistryTemplate } from './template-registry.types';

const EGYPT = '+201001112223';
const SAUDI = '+966501234567';
const JORDAN = '+962791234567';
const US = '+14155550101';
const ON = { reminderTemplate: true, arabicStyleAuto: true };

const seed = seededRegistryTemplates();
const reminders = [
  reminderTemplate('ar', 'standard_v1', { isDefault: true }),
  reminderTemplate('ar', 'egyptian_v1'),
  reminderTemplate('ar', 'gulf_v1'),
  reminderTemplate('en', 'friendly_v1', { isDefault: true }),
  reminderTemplate('en', 'direct_v1'),
];
const registry = [...seed, ...reminders];

function withRow(
  rows: RegistryTemplate[],
  key: string,
  change: Partial<RegistryTemplate>,
): RegistryTemplate[] {
  return rows.map((row) => (row.key === key ? { ...row, ...change } : row));
}

function sent(selection: ReturnType<typeof selectTemplateForSend>) {
  if (!selection.template) throw new Error('nothing selected');
  return {
    name: selection.template.templateName,
    variant: selection.template.variantKey,
    storedKey: selection.storedKey,
    fallbackReason: selection.fallbackReason,
  };
}

describe('selectTemplateForSend: reminder purpose (US-08-07a)', () => {
  const base = {
    preferredLanguage: 'auto',
    phoneNumber: EGYPT,
    arKey: 'cod_confirm.ar.egyptian',
    enKey: 'cod_confirm.en.direct',
    arReminderKey: 'cod_reminder.ar.egyptian_v1',
    enReminderKey: 'cod_reminder.en.direct_v1',
    kind: 'follow_up' as const,
  };

  it('sends the store reminder template for the resolved language', () => {
    expect(
      sent(selectTemplateForSend(registry, { ...base, switches: ON })),
    ).toEqual({
      name: 'akeed_cod_reminder_egyptian_v1',
      variant: 'ar.egyptian_v1',
      storedKey: 'cod_reminder.ar.egyptian_v1',
      fallbackReason: undefined,
    });
    expect(
      sent(
        selectTemplateForSend(registry, {
          ...base,
          phoneNumber: US,
          switches: ON,
        }),
      ).name,
    ).toBe('akeed_cod_reminder_direct_v1');
  });

  it('with the switch off, or for the first send, changes nothing', () => {
    const today = sent(
      selectTemplateForSend(seed, {
        ...base,
        arReminderKey: undefined,
        enReminderKey: undefined,
        kind: undefined,
      }),
    );
    for (const params of [
      { ...base },
      { ...base, switches: { reminderTemplate: false } },
      { ...base, kind: 'initial' as const, switches: ON },
    ]) {
      expect(sent(selectTemplateForSend(registry, params))).toEqual(today);
    }
    expect(today.name).toBe('akeed_cod_verification_direct_eg');
  });

  it('with no reminder chosen, the reminder is the first-send template, with no reason', () => {
    expect(
      sent(
        selectTemplateForSend(registry, {
          ...base,
          arReminderKey: null,
          switches: ON,
        }),
      ),
    ).toEqual({
      name: 'akeed_cod_verification_direct_eg',
      variant: 'ar.egyptian',
      storedKey: 'cod_confirm.ar.egyptian',
      fallbackReason: undefined,
    });
  });

  it('a chosen reminder that cannot be sent falls to the language reminder default', () => {
    const rows = withRow(registry, 'cod_reminder.ar.egyptian_v1', {
      isActive: false,
    });
    expect(
      sent(selectTemplateForSend(rows, { ...base, switches: ON })),
    ).toEqual({
      name: 'akeed_cod_reminder_standard_v1',
      variant: 'ar.standard_v1',
      storedKey: 'cod_reminder.ar.egyptian_v1',
      fallbackReason: 'key_inactive',
    });
  });

  it('a reminder key of the wrong purpose is not sent as a reminder', () => {
    expect(
      sent(
        selectTemplateForSend(registry, {
          ...base,
          arReminderKey: 'cod_confirm.ar.gulf',
          switches: ON,
        }),
      ),
    ).toMatchObject({
      name: 'akeed_cod_reminder_standard_v1',
      fallbackReason: 'wrong_language',
    });
  });

  it('with no sendable reminder at all, falls to the first-send template with reminder_unavailable', () => {
    const rows = [
      ...seed,
      reminderTemplate('ar', 'egyptian_v1', { isActive: false }),
    ];
    expect(
      sent(selectTemplateForSend(rows, { ...base, switches: ON })),
    ).toEqual({
      name: 'akeed_cod_verification_direct_eg',
      variant: 'ar.egyptian',
      storedKey: 'cod_reminder.ar.egyptian_v1',
      fallbackReason: 'reminder_unavailable',
    });
  });

  it('under the guardrail, an unapproved reminder is not sent', () => {
    const rows = withRow(
      syncedApprovedTemplates(registry),
      'cod_reminder.ar.egyptian_v1',
      { reviewStatus: 'pending' },
    );
    expect(
      sent(
        selectTemplateForSend(rows, {
          ...base,
          switches: ON,
          guardrail: { enabled: true },
        }),
      ),
    ).toMatchObject({
      name: 'akeed_cod_reminder_standard_v1',
      fallbackReason: 'not_approved',
    });
  });

  it('never skips a reminder only because no reminder template exists', () => {
    const selection = selectTemplateForSend(seed, {
      ...base,
      switches: ON,
    });
    expect(selection.template?.templateName).toBe(
      'akeed_cod_verification_direct_eg',
    );
  });
});

describe('selectTemplateForSend: Arabic style by country (US-08-07d)', () => {
  const base = {
    preferredLanguage: 'auto',
    arKey: 'cod_confirm.ar.short',
    arAuto: true,
  };

  it.each([
    [EGYPT, 'akeed_cod_verification_direct_eg', 'ar.egyptian'],
    [SAUDI, 'akeed_cod_verification_direct_gulf', 'ar.gulf'],
    [JORDAN, 'akeed_cod_verification_friendly', 'ar.standard'],
  ])('a store on auto sends %s the mapped style', (phone, name, variant) => {
    expect(
      sent(
        selectTemplateForSend(registry, {
          ...base,
          phoneNumber: phone,
          switches: ON,
        }),
      ),
    ).toMatchObject({ name, variant, fallbackReason: undefined });
  });

  it('with the switch off, or a store not on auto, sends the stored style', () => {
    for (const params of [
      { ...base, phoneNumber: EGYPT },
      { ...base, phoneNumber: EGYPT, arAuto: false, switches: ON },
    ]) {
      expect(sent(selectTemplateForSend(registry, params)).name).toBe(
        'akeed_cod_verification',
      );
    }
  });

  it('never applies to an English send', () => {
    expect(
      sent(
        selectTemplateForSend(registry, {
          ...base,
          phoneNumber: US,
          switches: ON,
        }),
      ).name,
    ).toBe('akeed_cod_verification_friendly');
  });

  it('applies to a store that forces Arabic, reading the number for the style', () => {
    expect(
      sent(
        selectTemplateForSend(registry, {
          ...base,
          preferredLanguage: 'ar',
          phoneNumber: SAUDI,
          switches: ON,
        }),
      ).name,
    ).toBe('akeed_cod_verification_direct_gulf');
  });

  it('a mapped style that cannot be sent falls to the Arabic default with auto_style_unavailable', () => {
    const rows = withRow(registry, 'cod_confirm.ar.gulf', { isActive: false });
    expect(
      sent(
        selectTemplateForSend(rows, {
          ...base,
          phoneNumber: SAUDI,
          switches: ON,
        }),
      ),
    ).toEqual({
      name: 'akeed_cod_verification_friendly',
      variant: 'ar.standard',
      storedKey: 'cod_confirm.ar.gulf',
      fallbackReason: 'auto_style_unavailable',
    });
  });

  it('finds a staff-written version of the mapped style', () => {
    const rows = [
      ...withRow(seed, 'cod_confirm.ar.gulf', { isActive: false }),
      {
        ...seed.find(({ key }) => key === 'cod_confirm.ar.gulf')!,
        key: 'cod_confirm.ar.gulf_v2',
        style: 'gulf_v2',
        templateName: 'akeed_cod_confirm_gulf_v2',
      },
    ];
    expect(
      sent(
        selectTemplateForSend(rows, {
          ...base,
          phoneNumber: SAUDI,
          switches: ON,
        }),
      ).name,
    ).toBe('akeed_cod_confirm_gulf_v2');
  });

  it('a store on auto with a reminder set gets the reminder of the same mapped style', () => {
    expect(
      sent(
        selectTemplateForSend(registry, {
          ...base,
          phoneNumber: SAUDI,
          kind: 'follow_up',
          arReminderKey: 'cod_reminder.ar.egyptian_v1',
          switches: ON,
        }),
      ),
    ).toMatchObject({
      name: 'akeed_cod_reminder_gulf_v1',
      fallbackReason: undefined,
    });
    const rows = withRow(registry, 'cod_reminder.ar.gulf_v1', {
      isActive: false,
    });
    expect(
      sent(
        selectTemplateForSend(rows, {
          ...base,
          phoneNumber: SAUDI,
          kind: 'follow_up',
          arReminderKey: 'cod_reminder.ar.egyptian_v1',
          switches: ON,
        }),
      ),
    ).toMatchObject({
      name: 'akeed_cod_reminder_standard_v1',
      fallbackReason: 'auto_style_unavailable',
    });
  });

  it('a store on auto without a reminder sends the mapped first-send template as the reminder', () => {
    expect(
      sent(
        selectTemplateForSend(registry, {
          ...base,
          phoneNumber: EGYPT,
          kind: 'follow_up',
          switches: ON,
        }),
      ).name,
    ).toBe('akeed_cod_verification_direct_eg');
  });
});

describe('findSendableByStyle', () => {
  it('prefers the exact style, then the newest version, and skips what cannot be sent', () => {
    const rows = [
      reminderTemplate('ar', 'gulf_v1'),
      reminderTemplate('ar', 'gulf_v3', { isActive: false }),
      reminderTemplate('ar', 'gulf_v2'),
      reminderTemplate('ar', 'gulfish_v9'),
    ];
    const find = (list: RegistryTemplate[]) =>
      findSendableByStyle(list, {
        language: 'ar',
        purpose: 'cod_reminder',
        style: 'gulf',
      })?.style;
    expect(find(rows)).toBe('gulf_v2');
    expect(find([...rows, reminderTemplate('ar', 'gulf')])).toBe('gulf');
    expect(find([reminderTemplate('ar', 'gulfish_v9')])).toBeUndefined();
  });
});
