import { validateEnv } from './env-validation';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  isWhatsappTemplateOperator,
  normalizeTemplateTestPhone,
  parseWhatsappTemplateConfig,
  readWhatsappTemplateConfig,
  type WhatsappTemplateConfig,
} from './whatsapp-template.config';

const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

describe('parseWhatsappTemplateConfig', () => {
  it('ships with every switch off and nobody allowed to write', () => {
    const config = parseWhatsappTemplateConfig({});
    expect(config).toMatchObject({
      syncEnabled: false,
      guardrailEnabled: false,
      operationsEnabled: false,
      businessAccountId: null,
    });
    expect(isWhatsappTemplateOperator(config, OPERATOR)).toBe(false);
  });

  it('ships with every US-08-07 switch off, and reads each on its own', () => {
    expect(parseWhatsappTemplateConfig({}).messageImprovements).toEqual({
      reminderTemplate: false,
      acknowledgment: false,
      unresolvedReplyNudge: false,
      arabicStyleAuto: false,
      localizedFallbacks: false,
      amountFormatting: false,
      snapshotPreview: false,
    });
    const names = {
      WHATSAPP_REMINDER_TEMPLATE_ENABLED: 'reminderTemplate',
      WHATSAPP_ACKNOWLEDGMENT_ENABLED: 'acknowledgment',
      WHATSAPP_UNRESOLVED_REPLY_NUDGE_ENABLED: 'unresolvedReplyNudge',
      WHATSAPP_ARABIC_STYLE_AUTO_ENABLED: 'arabicStyleAuto',
      WHATSAPP_LOCALIZED_FALLBACKS_ENABLED: 'localizedFallbacks',
      WHATSAPP_AMOUNT_FORMATTING_ENABLED: 'amountFormatting',
      WHATSAPP_SNAPSHOT_PREVIEW_ENABLED: 'snapshotPreview',
    } as const;
    for (const [key, name] of Object.entries(names)) {
      const switches = parseWhatsappTemplateConfig({
        [key]: 'true',
      }).messageImprovements;
      expect(Object.entries(switches).filter(([, on]) => on)).toEqual([
        [name, true],
      ]);
    }
  });

  it('rejects a US-08-07 switch that is not true or false', () => {
    expect(() =>
      parseWhatsappTemplateConfig({ WHATSAPP_ACKNOWLEDGMENT_ENABLED: 'yes' }),
    ).toThrow(/WHATSAPP_ACKNOWLEDGMENT_ENABLED must be true or false/);
  });

  it('has no test phone until one is listed, and keeps each as + and digits', () => {
    expect(parseWhatsappTemplateConfig({}).testPhones.size).toBe(0);
    expect([
      ...parseWhatsappTemplateConfig({
        WHATSAPP_TEMPLATE_TEST_PHONES:
          ' +20 100 123 4567 , 966501234567,00971-50-123-4567 ,',
      }).testPhones,
    ]).toEqual(['+201001234567', '+966501234567', '+971501234567']);
  });

  it('rejects a test phone that is not an international number, without echoing it', () => {
    for (const value of [
      '01001234567',
      '+20abc',
      '12345',
      '+2010012345678901',
    ]) {
      let message = '';
      try {
        parseWhatsappTemplateConfig({ WHATSAPP_TEMPLATE_TEST_PHONES: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/WHATSAPP_TEMPLATE_TEST_PHONES must be/);
      expect(message).not.toContain(value);
    }
    expect(normalizeTemplateTestPhone('(+20) 100-123.4567')).toBe(
      '+201001234567',
    );
  });

  it('requires the WhatsApp Business Account ID only when sync is on', () => {
    expect(() =>
      parseWhatsappTemplateConfig({ WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true' }),
    ).toThrow(/WA_BUSINESS_ACCOUNT_ID is required/);
    expect(
      parseWhatsappTemplateConfig({
        WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
        WA_BUSINESS_ACCOUNT_ID: ' 100000000000001 ',
      }),
    ).toMatchObject({
      syncEnabled: true,
      businessAccountId: '100000000000001',
    });
    expect(() =>
      parseWhatsappTemplateConfig({
        WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED: 'true',
      }),
    ).not.toThrow();
  });

  it('rejects an account ID that is not numeric', () => {
    expect(() =>
      parseWhatsappTemplateConfig({ WA_BUSINESS_ACCOUNT_ID: 'waba-1' }),
    ).toThrow(/must be the numeric account ID/);
  });

  it('rejects a switch that is not true or false', () => {
    expect(() =>
      parseWhatsappTemplateConfig({
        WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED: 'yes',
      }),
    ).toThrow(/WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED must be true or false/);
  });

  it('lets every staff member write when operations are on and no operator is listed', () => {
    for (const ids of [undefined, '', ' , ']) {
      const open = parseWhatsappTemplateConfig({
        WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
        ...(ids === undefined ? {} : { WHATSAPP_TEMPLATE_OPERATOR_IDS: ids }),
      });
      expect(open.operatorIds.size).toBe(0);
      expect(isWhatsappTemplateOperator(open, OPERATOR)).toBe(true);
    }
  });

  it('refuses an operator ID that is not a UUID', () => {
    expect(() =>
      parseWhatsappTemplateConfig({ WHATSAPP_TEMPLATE_OPERATOR_IDS: 'alice' }),
    ).toThrow(/comma-separated list of staff user UUIDs/);
  });

  it('allows only named operators, and only while the switch is on', () => {
    const on = parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
      WHATSAPP_TEMPLATE_OPERATOR_IDS: ` ${OPERATOR.toUpperCase()} ,`,
    });
    expect(isWhatsappTemplateOperator(on, OPERATOR)).toBe(true);
    expect(
      isWhatsappTemplateOperator(on, '0f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a'),
    ).toBe(false);
    const off = parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_OPERATOR_IDS: OPERATOR,
    });
    expect(isWhatsappTemplateOperator(off, OPERATOR)).toBe(false);
  });

  it('is part of validateEnv, which refuses to start sync without the account ID', () => {
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/db',
    };
    expect(() =>
      validateEnv({ ...base, WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true' }),
    ).toThrow(/WA_BUSINESS_ACCOUNT_ID is required/);
    const validated = validateEnv(base);
    expect(
      readWhatsappTemplateConfig({
        get: <T>(key: string) => validated[key] as T,
      }),
    ).toMatchObject<Partial<WhatsappTemplateConfig>>({ syncEnabled: false });
  });

  it('refuses to read a configuration that was never validated', () => {
    expect(() => readWhatsappTemplateConfig({ get: () => undefined })).toThrow(
      /was not validated/,
    );
    expect(WHATSAPP_TEMPLATE_CONFIG).toBe('whatsappTemplates');
  });
});
