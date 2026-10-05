import { validateEnv } from './env-validation';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  isWhatsappTemplateOperator,
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

  it('refuses operations without an operator, and an operator ID that is not a UUID', () => {
    expect(() =>
      parseWhatsappTemplateConfig({
        WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
      }),
    ).toThrow(/must name at least one staff user/);
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
