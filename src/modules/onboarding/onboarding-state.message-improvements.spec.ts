import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import {
  MESSAGE_IMPROVEMENT_SWITCHES_OFF,
  type MessageImprovementSwitchState,
} from '../../shared/config/whatsapp-template.config';
import {
  reminderTemplate,
  seededRegistryTemplates,
  seededTemplateRegistry,
} from '../../shared/messaging/testing/seeded-template-registry';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { UpdateOnboardingSettingsDto } from './dto/onboarding.dto';
import { OnboardingStateService } from './onboarding-state.service';
import { OnboardingService } from './onboarding.service';

/**
 * US-08-07 a and d in Settings: the reminder style per language and the
 * Arabic `auto` style, saved through the settings write and read back
 * through the settings response, each offered only while its switch is on.
 */
const owner: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'supabase',
};

const FORM = {
  storeName: 'Akeed Fashion',
  defaultLanguage: 'auto' as const,
  isAutoVerifyEnabled: true,
};

const TEMPLATES = [
  ...seededRegistryTemplates(),
  reminderTemplate('ar', 'standard_v1', { isDefault: true }),
  reminderTemplate('ar', 'gulf_v1'),
  reminderTemplate('ar', 'egyptian_v1', { isActive: false }),
  reminderTemplate('en', 'friendly_v1', { isDefault: true }),
];

function setup(
  switchesOn: Partial<MessageImprovementSwitchState> = {},
  stored: Record<string, unknown> = {},
  templates: RegistryTemplate[] = TEMPLATES,
) {
  const switches = {
    current: () => ({ ...MESSAGE_IMPROVEMENT_SWITCHES_OFF, ...switchesOn }),
  };
  let row: Record<string, unknown> = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'standalone',
    platformStoreUrl: 'standalone:org-1',
    isActive: true,
    billingStatus: 'active',
    storeName: 'Akeed Fashion',
    defaultLanguage: 'auto',
    isAutoVerifyEnabled: true,
    onboardingStatus: 'completed',
    followUpEnabled: true,
    followUpDelayMinutes: 120,
    escalationEnabled: true,
    escalationDelayMinutes: 360,
    quietHoursEnabled: false,
    codTemplateArVariant: 'standard',
    codTemplateEnVariant: 'friendly',
    codTemplateArKey: null,
    codTemplateEnKey: null,
    codReminderArKey: null,
    codReminderEnKey: null,
    codTemplateArAuto: false,
    ...stored,
  };
  const integrationsRepo = {
    findActiveByOrg: jest.fn(() => Promise.resolve([row])),
    updateById: jest.fn((_id: string, updates: Record<string, unknown>) => {
      row = { ...row, ...updates };
      return Promise.resolve(row);
    }),
  };
  const registry = seededTemplateRegistry(templates);
  const state = new OnboardingStateService(
    integrationsRepo as never,
    {} as never,
    registry,
    undefined,
    undefined,
    undefined,
    undefined,
    switches as never,
  );
  const settings = new OnboardingService(
    state,
    {
      getBillingPlans: jest
        .fn()
        .mockResolvedValue({ plans: [], isFreePlanClaimed: false }),
    } as never,
    new BillingEntitlementService(
      {
        getEntitlementSource: jest.fn(() => Promise.resolve(row)),
        getIntegrationUsageForPeriod: jest
          .fn()
          .mockResolvedValue({ consumedCount: 0, includedLimit: 300 }),
      } as never,
      usageAccountingFixture(),
    ),
    { readStatus: jest.fn().mockResolvedValue(null) } as never,
    registry,
    undefined,
    undefined,
    undefined,
    undefined,
    switches as never,
  );
  return { state, settings, integrationsRepo, current: () => row };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return (error as BadRequestException).getResponse();
}

describe('reminder style settings (US-08-07a)', () => {
  it('with the switch off, the response has no reminder block and a reminder write is refused', async () => {
    const { settings } = setup();
    const response = await settings.getSettings(owner);
    expect(response.template).not.toHaveProperty('reminder');
    expect(response.template).not.toHaveProperty('arabicAuto');
    expect(
      await rejection(
        settings.updateSettingsResponse(owner, {
          ...FORM,
          codReminderArVariant: 'gulf_v1',
        }),
      ),
    ).toMatchObject({ code: 'SETTINGS_REMINDER_STYLE_UNAVAILABLE' });
  });

  it('offers the active reminders per language, with nothing chosen', async () => {
    const { settings } = setup({ reminderTemplate: true });
    const { template } = await settings.getSettings(owner);
    expect(template.reminder).toEqual({
      selected: { ar: null, en: null },
      variants: {
        ar: [
          expect.objectContaining({ variant: 'standard_v1' }),
          expect.objectContaining({ variant: 'gulf_v1' }),
        ],
        en: [expect.objectContaining({ variant: 'friendly_v1' })],
      },
    });
  });

  it('saves a reminder style as its key and reads it back, and null clears it', async () => {
    const { settings, current } = setup({ reminderTemplate: true });
    const saved = await settings.updateSettingsResponse(owner, {
      ...FORM,
      codReminderArVariant: 'gulf_v1',
    });
    expect(current().codReminderArKey).toBe('cod_reminder.ar.gulf_v1');
    expect(saved.template.reminder?.selected).toEqual({
      ar: 'gulf_v1',
      en: null,
    });
    await settings.updateSettingsResponse(owner, {
      ...FORM,
      codReminderArVariant: null,
    });
    expect(current().codReminderArKey).toBeNull();
  });

  it('refuses an inactive reminder, a first-send style and the other language', async () => {
    const { settings, current } = setup({ reminderTemplate: true });
    for (const payload of [
      { codReminderArVariant: 'egyptian_v1' },
      { codReminderArVariant: 'gulf' },
      { codReminderEnVariant: 'gulf_v1' },
    ]) {
      expect(
        await rejection(
          settings.updateSettingsResponse(owner, { ...FORM, ...payload }),
        ),
      ).toMatchObject({ code: 'SETTINGS_REMINDER_STYLE_UNAVAILABLE' });
    }
    expect(current().codReminderArKey).toBeNull();
  });

  it('reads a stored reminder that is no longer selectable as same as the first message', async () => {
    const { settings } = setup(
      { reminderTemplate: true },
      { codReminderArKey: 'cod_reminder.ar.egyptian_v1' },
    );
    const { template } = await settings.getSettings(owner);
    expect(template.reminder?.selected.ar).toBeNull();
  });

  it('accepts null and a style in the DTO, and refuses an empty string', async () => {
    for (const [value, valid] of [
      [null, true],
      ['gulf_v1', true],
      ['', false],
      [7, false],
    ] as const) {
      const errors = await validate(
        plainToInstance(UpdateOnboardingSettingsDto, {
          ...FORM,
          codReminderArVariant: value,
        }),
      );
      expect(errors.length === 0).toBe(valid);
    }
  });
});

describe('Arabic auto style settings (US-08-07d)', () => {
  it('saves auto and reads it back, keeping the stored Arabic style for when it is turned off', async () => {
    const { settings, current } = setup(
      { arabicStyleAuto: true },
      { codTemplateArKey: 'cod_confirm.ar.gulf' },
    );
    const saved = await settings.updateSettingsResponse(owner, {
      ...FORM,
      codTemplateArAuto: true,
    });
    expect(current().codTemplateArAuto).toBe(true);
    expect(saved.template.arabicAuto).toEqual({ selected: true });
    expect(saved.template.selected.ar).toBe('gulf');
    await settings.updateSettingsResponse(owner, {
      ...FORM,
      codTemplateArAuto: false,
    });
    expect(current().codTemplateArAuto).toBe(false);
  });

  it('refuses turning auto on while the switch is off, and always allows turning it off', async () => {
    const { settings, current } = setup({}, { codTemplateArAuto: true });
    expect(
      await rejection(
        settings.updateSettingsResponse(owner, {
          ...FORM,
          codTemplateArAuto: true,
        }),
      ),
    ).toMatchObject({ code: 'SETTINGS_ARABIC_AUTO_UNAVAILABLE' });
    await settings.updateSettingsResponse(owner, {
      ...FORM,
      codTemplateArAuto: false,
    });
    expect(current().codTemplateArAuto).toBe(false);
  });
});
