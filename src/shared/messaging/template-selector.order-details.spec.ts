import { canFillTemplate, type OrderDetails } from './order-detail-values';
import type { RegistryTemplate } from './template-registry.types';
import { selectTemplateForSend } from './template-selector';
import {
  reminderTemplate,
  seededRegistryTemplates,
} from './testing/seeded-template-registry';

const ARABIC_PHONE = '+201001112223';
const DETAILED_KEY = 'cod_confirm.ar.detailed_v1';

/** A staff-written Arabic template that shows the items and the address. */
function detailed(change: Partial<RegistryTemplate> = {}): RegistryTemplate {
  const standard = seededRegistryTemplates().find(
    (template) => template.key === 'cod_confirm.ar.standard',
  )!;
  return {
    ...standard,
    key: DETAILED_KEY,
    style: 'detailed_v1',
    templateName: 'akeed_cod_confirm_detailed_v1',
    isDefault: false,
    variables: [
      { key: 'customer', name: 'customer' },
      { key: 'order', name: 'order' },
      { key: 'items', name: 'items' },
      { key: 'total', name: 'total' },
      { key: 'region', name: 'region' },
      { key: 'address', name: 'address' },
    ],
    ...change,
  };
}

const WITH_DETAILS: OrderDetails = {
  lineItems: [
    { name: 'Lunch box', quantity: 1, unitPrice: '180', options: [] },
  ],
  shippingRegion: 'القاهرة',
  shippingAddress: 'حلوان',
};

function select(
  order: OrderDetails,
  options: {
    templates?: RegistryTemplate[];
    params?: Partial<Parameters<typeof selectTemplateForSend>[1]>;
  } = {},
) {
  return selectTemplateForSend(
    options.templates ?? [...seededRegistryTemplates(), detailed()],
    {
      preferredLanguage: 'ar',
      phoneNumber: ARABIC_PHONE,
      arKey: DETAILED_KEY,
      canFill: (variables) => canFillTemplate(variables, order),
      ...options.params,
    },
  );
}

function fallbackReasonOf(
  selection: ReturnType<typeof selectTemplateForSend>,
): string | undefined {
  return 'fallbackReason' in selection ? selection.fallbackReason : undefined;
}

describe('selectTemplateForSend and order details', () => {
  it('sends the detailed template to an order that has items and an address', () => {
    const selection = select(WITH_DETAILS);

    expect(selection.template?.variantKey).toBe('ar.detailed_v1');
    expect(fallbackReasonOf(selection)).toBeUndefined();
  });

  it.each([
    ['no items', { ...WITH_DETAILS, lineItems: null }],
    ['no region', { ...WITH_DETAILS, shippingRegion: null }],
    ['no address', { ...WITH_DETAILS, shippingAddress: '' }],
    ['nothing at all', {}],
  ])(
    'sends the language default to an order with %s, and says why',
    (_case, order) => {
      expect(select(order)).toMatchObject({
        template: { variantKey: 'ar.standard' },
        storedKey: DETAILED_KEY,
        fallbackReason: 'order_details_missing',
      });
    },
  );

  it('leaves every other template alone, whatever the order holds', () => {
    const selection = select(
      {},
      { params: { arKey: 'cod_confirm.ar.egyptian' } },
    );

    expect(selection.template?.variantKey).toBe('ar.egyptian');
    expect(fallbackReasonOf(selection)).toBeUndefined();
  });

  it('selects as before when no order is given to check', () => {
    expect(
      selectTemplateForSend([...seededRegistryTemplates(), detailed()], {
        preferredLanguage: 'ar',
        phoneNumber: ARABIC_PHONE,
        arKey: DETAILED_KEY,
      }),
    ).toMatchObject({ template: { variantKey: 'ar.detailed_v1' } });
  });

  it('sends nothing when the default itself shows details the order lacks', () => {
    const templates = [
      ...seededRegistryTemplates().map((template) =>
        template.language === 'ar'
          ? { ...template, isDefault: false }
          : template,
      ),
      detailed({ isDefault: true }),
    ];

    expect(select({}, { templates })).toEqual({
      template: null,
      language: 'ar',
      storedKey: DETAILED_KEY,
      reason: 'default_unavailable',
    });
  });

  it('a detailed reminder the order cannot fill falls to the confirmation default', () => {
    const reminder = reminderTemplate('ar', 'detailed_v1', {
      variables: detailed().variables,
    });
    const selection = select(
      {},
      {
        templates: [...seededRegistryTemplates(), reminder],
        params: {
          arKey: 'cod_confirm.ar.egyptian',
          kind: 'follow_up',
          arReminderKey: reminder.key,
          switches: { reminderTemplate: true },
        },
      },
    );

    expect(selection).toMatchObject({
      template: { variantKey: 'ar.standard' },
      storedKey: reminder.key,
      fallbackReason: 'order_details_missing',
    });
  });
});
