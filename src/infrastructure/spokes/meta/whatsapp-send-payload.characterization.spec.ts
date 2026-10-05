import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { of } from 'rxjs';
import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../../shared/billing/entitlement';
import { VerificationSendService } from '../../../modules/verification-core/verification-send.service';
import { WhatsAppService } from './whatsapp.service';
import { seededTemplateRegistry } from '../../../shared/messaging/testing/seeded-template-registry';

/**
 * US-08-02 payload characterization, and the baseline US-08-03 cuts over
 * against.
 *
 * Every case runs the real send service and the real Meta adapter and compares
 * the request body with the one recorded from `develop` before template
 * selection moved out of the adapter. The fixture was recorded once and this
 * spec only compares: a difference means a customer would receive a different
 * message, so the fix is in the code, never in the fixture.
 *
 * The comparison is on `JSON.stringify`, which is what goes on the wire, so
 * key order and value types count. The fixture is pretty-printed for review;
 * parsing keeps its key order, so both sides serialize the same way.
 */
const VERIFICATION_ID = 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f607';
const ARABIC_PHONE = '+966500000001';
const NON_ARABIC_PHONE = '+14155550101';
const LOCAL_PHONE = '0501234567';

type SendPath = 'initial' | 'reminder' | 'test';

interface PayloadCase {
  name: string;
  path: SendPath;
  store: {
    defaultLanguage: string | null;
    codTemplateArVariant: string | null;
    codTemplateEnVariant: string | null;
    storeName: string | null;
  };
  order: {
    customerPhone: string;
    customerName: string | null;
    orderNumber: string | null;
    totalPrice: string;
    currency: string | null;
  };
}

const VARIANTS = [
  { language: 'ar', variant: 'standard' },
  { language: 'ar', variant: 'egyptian' },
  { language: 'ar', variant: 'gulf' },
  { language: 'ar', variant: 'short' },
  { language: 'en', variant: 'friendly' },
  { language: 'en', variant: 'professional' },
  { language: 'en', variant: 'direct' },
  { language: 'en', variant: 'short' },
] as const;

const SEND_PATHS: SendPath[] = ['initial', 'reminder', 'test'];

const REAL_ORDER = {
  customerName: 'Sara Ali',
  orderNumber: '1001',
  totalPrice: '349.50',
  currency: 'SAR',
};

/** What the onboarding and Settings test sends put in the template. */
const TEST_ORDER = {
  orderNumber: 'TEST-1',
  totalPrice: '250.00',
  currency: 'USD',
};
const TEST_CUSTOMER_NAMES = { ar: 'أحمد', en: 'Ahmed' } as const;

function variantCases(): PayloadCase[] {
  return VARIANTS.flatMap(({ language, variant }) =>
    SEND_PATHS.map((path): PayloadCase => {
      // The number belongs to the other language group, so the case also pins
      // that the store's forced language wins over the phone.
      const customerPhone = language === 'ar' ? NON_ARABIC_PHONE : ARABIC_PHONE;
      return {
        name: `${language}.${variant}/${path}`,
        path,
        store: {
          defaultLanguage: language,
          codTemplateArVariant: language === 'ar' ? variant : 'standard',
          codTemplateEnVariant: language === 'en' ? variant : 'friendly',
          storeName: 'Akeed Fashion',
        },
        order:
          path === 'test'
            ? {
                ...TEST_ORDER,
                customerPhone,
                customerName: TEST_CUSTOMER_NAMES[language],
              }
            : { ...REAL_ORDER, customerPhone },
      };
    }),
  );
}

const SELECTED_STORE = {
  codTemplateArVariant: 'egyptian',
  codTemplateEnVariant: 'professional',
  storeName: 'Akeed Fashion',
};

const EDGE_CASES: PayloadCase[] = [
  {
    name: 'auto/arabic-phone',
    path: 'initial',
    store: { ...SELECTED_STORE, defaultLanguage: 'auto' },
    order: { ...REAL_ORDER, customerPhone: ARABIC_PHONE },
  },
  {
    name: 'auto/non-arabic-phone',
    path: 'initial',
    store: { ...SELECTED_STORE, defaultLanguage: 'auto' },
    order: { ...REAL_ORDER, customerPhone: NON_ARABIC_PHONE },
  },
  {
    name: 'auto/local-number-without-country-code',
    path: 'initial',
    store: { ...SELECTED_STORE, defaultLanguage: 'auto' },
    order: { ...REAL_ORDER, customerPhone: LOCAL_PHONE },
  },
  {
    name: 'unset-language/arabic-phone',
    path: 'reminder',
    store: { ...SELECTED_STORE, defaultLanguage: null },
    order: { ...REAL_ORDER, customerPhone: ARABIC_PHONE },
  },
  {
    name: 'ar.standard/missing-names',
    path: 'initial',
    store: {
      defaultLanguage: 'ar',
      codTemplateArVariant: 'standard',
      codTemplateEnVariant: 'friendly',
      storeName: null,
    },
    order: { ...REAL_ORDER, customerPhone: ARABIC_PHONE, customerName: null },
  },
  {
    name: 'en.friendly/blank-names',
    path: 'initial',
    store: {
      defaultLanguage: 'en',
      codTemplateArVariant: 'standard',
      codTemplateEnVariant: 'friendly',
      storeName: '   ',
    },
    order: {
      ...REAL_ORDER,
      customerPhone: NON_ARABIC_PHONE,
      customerName: '  ',
    },
  },
  {
    name: 'ar/unknown-stored-variant',
    path: 'initial',
    store: {
      defaultLanguage: 'ar',
      codTemplateArVariant: 'retired_variant',
      codTemplateEnVariant: 'friendly',
      storeName: 'Akeed Fashion',
    },
    order: { ...REAL_ORDER, customerPhone: ARABIC_PHONE },
  },
  {
    name: 'en/missing-stored-variant',
    path: 'initial',
    store: {
      defaultLanguage: 'en',
      codTemplateArVariant: 'standard',
      codTemplateEnVariant: null,
      storeName: 'Akeed Fashion',
    },
    order: { ...REAL_ORDER, customerPhone: NON_ARABIC_PHONE },
  },
  {
    name: 'en.direct/order-number-and-currency-missing',
    path: 'initial',
    store: {
      defaultLanguage: 'en',
      codTemplateArVariant: 'standard',
      codTemplateEnVariant: 'direct',
      storeName: 'Akeed Fashion',
    },
    order: {
      ...REAL_ORDER,
      customerPhone: NON_ARABIC_PHONE,
      orderNumber: null,
      currency: null,
    },
  },
];

const CASES: PayloadCase[] = [...variantCases(), ...EDGE_CASES];

interface Baseline {
  url: string;
  cases: Record<string, unknown>;
}

const baseline = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../test/fixtures/whatsapp-templates/send-payloads/baseline.json',
    ),
    'utf8',
  ),
) as Baseline;

async function sendThrough(definition: PayloadCase) {
  const httpService = {
    post: jest
      .fn()
      .mockReturnValue(
        of({ data: { messages: [{ id: 'wamid.characterization' }] } }),
      ),
  };
  const configService = {
    get: (key: string) =>
      key === 'WA_ACCESS_TOKEN'
        ? 'synthetic-token'
        : key === 'WA_PHONE_NUMBER_ID'
          ? 'phone-number-id-test'
          : undefined,
  };
  const messaging = new WhatsAppService(
    httpService as never,
    configService as never,
  );
  const isTest = definition.path === 'test';
  const integration = {
    id: 'int-1',
    orgId: 'org-1',
    isActive: true,
    platformType: 'shopify',
    billingStatus: 'active',
    ...definition.store,
  };
  const sender = new VerificationSendService(
    {
      findById: jest.fn().mockResolvedValue({
        id: VERIFICATION_ID,
        orgId: 'org-1',
        orderId: 'order-1',
        status: definition.path === 'reminder' ? 'sent' : 'pending',
      }),
    } as never,
    {
      findById: jest.fn().mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        integrationId: 'int-1',
        externalOrderId: 'ext-9001',
        isTest,
        integration,
        ...definition.order,
      }),
    } as never,
    {
      evaluateAccess: (source: EntitlementSource) =>
        resolveEntitlement(source, source),
    } as never,
    { resolveDenial: jest.fn().mockResolvedValue(null) } as never,
    {
      claim: jest.fn().mockResolvedValue({
        outcome: 'claimed',
        dispatch: { id: 'dispatch-1' },
      }),
      markAccepted: jest.fn().mockResolvedValue({
        outcome: 'accepted',
        dispatch: { id: 'dispatch-1', state: 'accepted' },
      }),
    } as never,
    messaging,
    seededTemplateRegistry(),
  );

  const outcome =
    definition.path === 'reminder'
      ? await sender.sendFollowUp(VERIFICATION_ID)
      : await sender.sendInitial(VERIFICATION_ID, { billingExempt: isTest });

  const calls = httpService.post.mock.calls as [string, unknown][];
  return { outcome, calls };
}

describe('WhatsApp send payload characterization', () => {
  it('covers exactly the recorded cases', () => {
    expect(Object.keys(baseline.cases)).toEqual(CASES.map(({ name }) => name));
  });

  it.each(CASES)('sends the recorded payload for $name', async (definition) => {
    const { outcome, calls } = await sendThrough(definition);

    expect(outcome.status).toBe('sent');
    expect(calls).toHaveLength(1);
    const [url, payload] = calls[0];
    expect(url).toBe(baseline.url);
    expect(JSON.stringify(payload)).toBe(
      JSON.stringify(baseline.cases[definition.name]),
    );
  });
});
