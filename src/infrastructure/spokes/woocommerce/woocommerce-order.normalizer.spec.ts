import { Logger } from '@nestjs/common';
import type {
  WooCommerceConnection,
  WooCommerceConnectionsRepository,
} from '../../database/repositories/woocommerce-connections.repository';
import { PhoneService } from '../../../shared/services/phone.service';
import {
  checkoutDraftFixture,
  placedCodFixture,
  placedNonCodFixture,
  type WooCommerceOrderFixture,
} from '../../../../test/fixtures/woocommerce/load';
import { toStoredWooCommerceDelivery } from './woocommerce-delivery';
import { WooCommerceOrderNormalizer } from './woocommerce-order.normalizer';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';

function connection(
  overrides: Partial<WooCommerceConnection> = {},
): WooCommerceConnection {
  return {
    integrationId: INTEGRATION_ID,
    orgId: ORG_ID,
    storeUrl: 'https://example.com',
    storeVerifiedAt: '2025-12-31T00:00:00.000Z',
    consumerKeyEncrypted: 'v1:synthetic',
    consumerSecretEncrypted: 'v1:synthetic',
    webhookSecretEncrypted: 'v1:synthetic',
    webhookTokenHash: 'h'.repeat(64),
    orderCreatedWebhookId: 101,
    orderUpdatedWebhookId: 102,
    wooVersion: '9.8.1',
    health: 'ok',
    rejectedDeliveries: 0,
    lastRejectedAt: null,
    connectedBy: 'user-1',
    // Before every fixture order was created.
    connectedAt: '2025-12-31T00:00:00.000Z',
    createdAt: '2025-12-31T00:00:00.000Z',
    updatedAt: '2025-12-31T00:00:00.000Z',
    ...overrides,
  };
}

function createNormalizer(bound: WooCommerceConnection | null = connection()) {
  const findByIntegration = jest.fn().mockResolvedValue(bound ?? undefined);
  const normalizer = new WooCommerceOrderNormalizer(
    { findByIntegration } as unknown as WooCommerceConnectionsRepository,
    new PhoneService(),
  );
  return { normalizer, findByIntegration };
}

/** The event row's payload for an order, as the webhook service stores it. */
function stored(order: Record<string, unknown>): Record<string, unknown> {
  return { ...toStoredWooCommerceDelivery({ topic: 'order.created' }, order) };
}

function placed(
  overrides: Record<string, unknown> = {},
  billing: Record<string, unknown> = {},
): Record<string, unknown> {
  const order: WooCommerceOrderFixture = placedCodFixture().payload;
  return { ...order, ...overrides, billing: { ...order.billing, ...billing } };
}

describe('WooCommerceOrderNormalizer', () => {
  let warn: jest.SpyInstance;
  let warned: string[];

  beforeEach(() => {
    warned = [];
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => {
        warned.push(String(args[0]));
      });
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('handles the woocommerce platform', () => {
    expect(createNormalizer().normalizer.platform).toBe('woocommerce');
  });

  it('normalizes a placed cash-on-delivery order from the payload alone', async () => {
    const { normalizer, findByIntegration } = createNormalizer();
    const payload = stored(placed());

    await expect(
      normalizer.normalizeOrder(payload, INTEGRATION_ID, ORG_ID),
    ).resolves.toEqual({
      orgId: ORG_ID,
      integrationId: INTEGRATION_ID,
      externalOrderId: '1001',
      orderNumber: '1001',
      customerPhone: '+201000000000',
      customerName: 'Test Customer',
      totalPrice: '450.00',
      currency: 'EGP',
      paymentMethod: 'cod',
      paymentSignals: ['cod'],
      codStatus: 'cod',
      rawPayload: payload.order,
    });
    // The connection is loaded by the trusted identity it was handed.
    expect(findByIntegration).toHaveBeenCalledWith(INTEGRATION_ID, ORG_ID);
  });

  it('takes the tenant from the queue, never from the payload', async () => {
    const { normalizer } = createNormalizer();

    await expect(
      normalizer.normalizeOrder(
        stored(placed({ orgId: 'other-org', integrationId: 'other' })),
        INTEGRATION_ID,
        ORG_ID,
      ),
    ).resolves.toMatchObject({ orgId: ORG_ID, integrationId: INTEGRATION_ID });
  });

  it('starts an on-hold cash-on-delivery order', async () => {
    const { normalizer } = createNormalizer();

    await expect(
      normalizer.normalizeOrder(
        stored(placed({ status: 'on-hold' })),
        INTEGRATION_ID,
        ORG_ID,
      ),
    ).resolves.toMatchObject({ externalOrderId: '1001' });
  });

  it.each([
    ['a local number, read in the billing country', '01000000000', 'EG'],
    ['a local number with punctuation', '010 0000-0000', 'EG'],
    ['a lower-case billing country', '01000000000', 'eg'],
    ['a local Saudi number', '0512345678', 'SA'],
  ])('writes %s as E.164', async (_label, phone, country) => {
    const { normalizer } = createNormalizer();
    const expected =
      country.toUpperCase() === 'SA' ? '+966512345678' : '+201000000000';

    await expect(
      normalizer.normalizeOrder(
        stored(placed({}, { phone, country })),
        INTEGRATION_ID,
        ORG_ID,
      ),
    ).resolves.toMatchObject({ customerPhone: expected });
  });

  it.each([
    ['with a plus', '+966512345678', 'EG'],
    ['with 00', '00966512345678', 'EG'],
    ['with no billing country', '+966512345678', ''],
    ['with a billing country that is not a code', '+966 51 234 5678', 'Egypt'],
  ])(
    'takes an international number %s as it is',
    async (_label, phone, country) => {
      const { normalizer } = createNormalizer();

      await expect(
        normalizer.normalizeOrder(
          stored(placed({}, { phone, country })),
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).resolves.toMatchObject({ customerPhone: '+966512345678' });
    },
  );

  it.each([
    ['no phone', {}, { phone: '' }, 'incomplete_payload'],
    [
      'a local number without a billing country',
      {},
      { country: '' },
      'missing_phone_country',
    ],
    [
      'a local number with a country that is not a code',
      {},
      { country: 'Egypt' },
      'missing_phone_country',
    ],
    ['a number that does not parse', {}, { phone: '12345' }, 'invalid_phone'],
    [
      'a number for another country’s plan',
      {},
      { phone: '0512345678', country: 'EG' },
      'invalid_phone',
    ],
    ['a landline', {}, { phone: '0223456789' }, 'invalid_phone'],
    ['no currency', { currency: '' }, {}, 'missing_currency'],
    [
      'a currency Akeed does not serve',
      { currency: 'XXX' },
      {},
      'missing_currency',
    ],
    ['a currency that is not text', { currency: 818 }, {}, 'missing_currency'],
    ['a zero total', { total: '0.00' }, {}, 'invalid_amount'],
    ['a total that is not a decimal', { total: '4,50' }, {}, 'invalid_amount'],
    ['a total sent as a number', { total: 450 }, {}, 'invalid_amount'],
    ['no total', { total: '' }, {}, 'invalid_amount'],
  ])('records %s as %s', async (_label, overrides, billing, reason) => {
    const { normalizer } = createNormalizer();

    await expect(
      normalizer.normalizeOrder(
        stored(placed(overrides, billing)),
        INTEGRATION_ID,
        ORG_ID,
      ),
    ).resolves.toEqual({ skipped: true, reason });
  });

  it('accepts a lower-case currency code', async () => {
    const { normalizer } = createNormalizer();

    await expect(
      normalizer.normalizeOrder(
        stored(placed({ currency: 'sar' })),
        INTEGRATION_ID,
        ORG_ID,
      ),
    ).resolves.toMatchObject({ currency: 'SAR' });
  });

  it.each([
    [
      'a checkout draft',
      () => checkoutDraftFixture().payload,
      'order_not_placed',
    ],
    [
      'a pending order',
      () => placed({ status: 'pending' }),
      'order_not_placed',
    ],
    ['a custom status', () => placed({ status: 'packed' }), 'order_not_placed'],
    [
      'a bank-transfer order',
      () => placedNonCodFixture().payload,
      'non_cod_payment_method',
    ],
    [
      'an order without a payment method',
      () => placed({ payment_method: '' }),
      'missing_payment_signal',
    ],
  ])(
    'records %s with the reason the policy gives',
    async (_label, order, reason) => {
      const { normalizer } = createNormalizer();

      await expect(
        normalizer.normalizeOrder(stored(order()), INTEGRATION_ID, ORG_ID),
      ).resolves.toEqual({ skipped: true, reason });
    },
  );

  it('never starts an order older than the connection', async () => {
    const { normalizer } = createNormalizer(
      connection({ connectedAt: '2026-06-01T00:00:00.000Z' }),
    );

    await expect(
      normalizer.normalizeOrder(stored(placed()), INTEGRATION_ID, ORG_ID),
    ).resolves.toEqual({ skipped: true, reason: 'order_predates_connection' });
  });

  it('leaves out a missing order number and an empty name', async () => {
    const { normalizer } = createNormalizer();

    const result = await normalizer.normalizeOrder(
      stored(placed({ number: '' }, { first_name: '', last_name: ' ' })),
      INTEGRATION_ID,
      ORG_ID,
    );

    expect(result).toMatchObject({ externalOrderId: '1001' });
    expect(result).not.toHaveProperty('orderNumber');
    expect(result).not.toHaveProperty('customerName');
  });

  it('uses the one name the customer gave', async () => {
    const { normalizer } = createNormalizer();

    await expect(
      normalizer.normalizeOrder(
        stored(placed({}, { first_name: ' Noor ', last_name: '' })),
        INTEGRATION_ID,
        ORG_ID,
      ),
    ).resolves.toMatchObject({ customerName: 'Noor' });
  });

  it('records a connection that is gone', async () => {
    const { normalizer } = createNormalizer(null);

    await expect(
      normalizer.normalizeOrder(stored(placed()), INTEGRATION_ID, ORG_ID),
    ).resolves.toEqual({ skipped: true, reason: 'source_connection_missing' });
  });

  it.each([
    ['a row that is not a stored delivery', {}],
    ['an order without an id', { topic: 'order.created', order: {} }],
    ['an id that is not an integer', { order: { id: '1001' } }],
  ])(
    'records %s as incomplete without loading anything',
    async (_label, row) => {
      const { normalizer, findByIntegration } = createNormalizer();

      await expect(
        normalizer.normalizeOrder(row, INTEGRATION_ID, ORG_ID),
      ).resolves.toEqual({ skipped: true, reason: 'incomplete_payload' });
      expect(findByIntegration).not.toHaveBeenCalled();
    },
  );

  it('logs the reason and no customer data', async () => {
    const { normalizer } = createNormalizer();

    await normalizer.normalizeOrder(
      stored(placed({}, { phone: '12345' })),
      INTEGRATION_ID,
      ORG_ID,
    );

    const [line] = warned;
    expect(line).toContain('woocommerce-order-normalize');
    expect(line).toContain('invalid_phone');
    expect(line).not.toContain('12345');
    expect(line).not.toContain('Test');
  });
});
