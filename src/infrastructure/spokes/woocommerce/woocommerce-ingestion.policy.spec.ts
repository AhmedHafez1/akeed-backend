import {
  checkoutDraftFixture,
  orderUpdatedFixture,
  placedCodFixture,
  placedNonCodFixture,
} from '../../../../test/fixtures/woocommerce/load';
import {
  buildWooCommerceOrderCreateKey,
  evaluateWooCommerceStart,
  isWooCommerceCashOnDelivery,
  isWooCommerceCorrectableSkip,
  parseWooCommerceGmtDate,
  readWooCommerceOrderId,
  routeWooCommerceDelivery,
  WOOCOMMERCE_ORDER_DATA_SKIP_REASONS,
  type WooCommerceOrderHold,
} from './woocommerce-ingestion.policy';

const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';
/** Before every fixture order was created. */
const CONNECTED_AT = '2025-12-31T00:00:00.000Z';

const placed = placedCodFixture().payload;

describe('parseWooCommerceGmtDate', () => {
  it('reads the documented form as UTC', () => {
    expect(parseWooCommerceGmtDate('2026-01-01T10:00:00')).toBe(
      Date.UTC(2026, 0, 1, 10, 0, 0),
    );
  });

  it.each([
    undefined,
    null,
    '',
    1767261600,
    '2026-01-01',
    '2026-01-01 10:00:00',
    '2026-01-01T10:00:00Z',
    '2026-01-01T10:00:00+02:00',
    '2026-01-01T10:00:00.000',
    '2026-13-01T10:00:00',
    ' 2026-01-01T10:00:00',
  ])('treats %p as unreadable', (value) => {
    expect(parseWooCommerceGmtDate(value)).toBeNull();
  });
});

describe('readWooCommerceOrderId', () => {
  it('writes a positive integer as decimal text', () => {
    expect(readWooCommerceOrderId(1001)).toBe('1001');
  });

  it.each([undefined, null, '1001', 0, -1, 1.5, Number.NaN, 2 ** 53, {}, []])(
    'refuses %p',
    (value) => {
      expect(readWooCommerceOrderId(value)).toBeNull();
    },
  );
});

describe('isWooCommerceCashOnDelivery', () => {
  it.each([
    ['cod', true],
    [' cod ', true],
    ['COD', false],
    ['bacs', false],
    ['cod_custom', false],
    ['', false],
    [undefined, false],
    [null, false],
  ])('%p: %s', (method, expected) => {
    expect(isWooCommerceCashOnDelivery(method)).toBe(expected);
  });
});

describe('evaluateWooCommerceStart', () => {
  it.each(['processing', 'on-hold'])(
    'starts a %s cash-on-delivery order',
    (status) => {
      expect(
        evaluateWooCommerceStart({ ...placed, status }, CONNECTED_AT),
      ).toEqual({ start: true });
    },
  );

  it.each([
    ['a checkout draft', checkoutDraftFixture().payload, 'order_not_placed'],
    ['a pending order', { ...placed, status: 'pending' }, 'order_not_placed'],
    ['a custom status', { ...placed, status: 'packed' }, 'order_not_placed'],
    ['a completed order', orderUpdatedFixture().payload, 'order_not_placed'],
    ['a status that is not text', { ...placed, status: 7 }, 'order_not_placed'],
    ['no status', { ...placed, status: undefined }, 'order_not_placed'],
    [
      'a bank-transfer order',
      placedNonCodFixture().payload,
      'non_cod_payment_method',
    ],
    [
      'a custom gateway',
      { ...placed, payment_method: 'cod_plus' },
      'non_cod_payment_method',
    ],
    [
      'an empty payment method',
      { ...placed, payment_method: '' },
      'missing_payment_signal',
    ],
    [
      'no payment method',
      { ...placed, payment_method: null },
      'missing_payment_signal',
    ],
  ])('skips %s as %s', (_label, order, reason) => {
    expect(evaluateWooCommerceStart(order, CONNECTED_AT)).toEqual({
      start: false,
      reason,
    });
  });

  it.each([
    ['created before the connection', '2026-01-01T09:59:59'],
    ['without a creation date', undefined],
    ['with an unreadable creation date', 'yesterday'],
  ])('never starts an order %s', (_label, createdAt) => {
    expect(
      evaluateWooCommerceStart(
        { ...placed, date_created_gmt: createdAt },
        '2026-01-01T10:00:00.000Z',
      ),
    ).toEqual({ start: false, reason: 'order_predates_connection' });
  });

  it('names the age first, whatever else is wrong with the order', () => {
    expect(
      evaluateWooCommerceStart(
        { ...checkoutDraftFixture().payload },
        '2027-01-01T00:00:00.000Z',
      ),
    ).toEqual({ start: false, reason: 'order_predates_connection' });
  });

  it('compares at the second the order date is written in', () => {
    // Connected 900 ms into the second the order was created in.
    expect(
      evaluateWooCommerceStart(
        { ...placed, date_created_gmt: '2026-01-01T10:00:00' },
        '2026-01-01T10:00:00.900Z',
      ),
    ).toEqual({ start: true });
    expect(
      evaluateWooCommerceStart(
        { ...placed, date_created_gmt: '2026-01-01T10:00:00' },
        new Date('2026-01-01T10:00:01.000Z'),
      ),
    ).toEqual({ start: false, reason: 'order_predates_connection' });
  });

  it('starts nothing when the connection moment is unreadable', () => {
    expect(evaluateWooCommerceStart(placed, 'not-a-date')).toEqual({
      start: false,
      reason: 'order_predates_connection',
    });
  });
});

describe('isWooCommerceCorrectableSkip', () => {
  it.each(WOOCOMMERCE_ORDER_DATA_SKIP_REASONS)(
    'is true for a create event skipped as %s',
    (reason) => {
      expect(
        isWooCommerceCorrectableSkip({ status: 'skipped', lastError: reason }),
      ).toBe(true);
    },
  );

  it.each([
    ['waiting', { status: 'pending', lastError: null }],
    ['running', { status: 'processing', lastError: null }],
    ['done', { status: 'completed', lastError: null }],
    [
      'failed with the same text',
      { status: 'failed', lastError: 'invalid_phone' },
    ],
    [
      'skipped by the start rule',
      { status: 'skipped', lastError: 'order_not_placed' },
    ],
    [
      'skipped for the source',
      { status: 'skipped', lastError: 'integration_inactive' },
    ],
    [
      'skipped for the account',
      { status: 'skipped', lastError: 'billing_not_active' },
    ],
    ['skipped with no reason', { status: 'skipped', lastError: null }],
    [
      'skipped with a reason that is not text',
      { status: 'skipped', lastError: { a: 1 } },
    ],
    ['empty', {}],
  ])('is false for an event that is %s', (_label, event) => {
    expect(isWooCommerceCorrectableSkip(event)).toBe(false);
  });

  it('names only what the merchant can correct on the order', () => {
    expect([...WOOCOMMERCE_ORDER_DATA_SKIP_REASONS].sort()).toEqual([
      'incomplete_payload',
      'invalid_amount',
      'invalid_phone',
      'order_currency_unsupported',
      'order_phone_country_missing',
    ]);
  });
});

describe('routeWooCommerceDelivery', () => {
  const route = (
    order: Record<string, unknown>,
    held: WooCommerceOrderHold = 'none',
    connectedAt = CONNECTED_AT,
  ) =>
    routeWooCommerceDelivery({
      integrationId: INTEGRATION_ID,
      orderId: '1001',
      order,
      connectedAt,
      held,
    });

  it('sends a placed cash-on-delivery order to the create path under the semantic key', () => {
    expect(route(placed)).toEqual({
      route: 'create',
      jobType: 'order.create',
      idempotencyKey: `order.create:${INTEGRATION_ID}:1001`,
    });
    expect(buildWooCommerceOrderCreateKey(INTEGRATION_ID, '1001')).toBe(
      `order.create:${INTEGRATION_ID}:1001`,
    );
  });

  it('gives the same key whichever topic delivered the order', () => {
    // The topic is not an input: created and updated arriving together for a
    // placed order resolve to one key.
    expect(route(placed).idempotencyKey).toBe(
      route({ ...placed, date_modified_gmt: '2026-01-01T10:05:00' })
        .idempotencyKey,
    );
  });

  it('records a draft under its own key, never the create key', () => {
    const draft = route(checkoutDraftFixture().payload);

    expect(draft).toEqual({
      route: 'skipped',
      jobType: 'order.create',
      idempotencyKey: `order.skip:${INTEGRATION_ID}:1001:checkout-draft:2026-01-01T10:00:00`,
      reason: 'order_not_placed',
    });
    expect(draft.idempotencyKey).not.toBe(route(placed).idempotencyKey);
  });

  it('sends every delivery of an order Akeed already has to the update path', () => {
    expect(route(orderUpdatedFixture().payload, 'taken')).toEqual({
      route: 'update',
      jobType: 'order.update',
      idempotencyKey: `order.update:${INTEGRATION_ID}:1001:completed:2026-01-02T07:30:00`,
    });
    // Even one that would start a verification on its own.
    expect(route(placed, 'taken').route).toBe('update');
  });

  describe('an order whose create event ended on its own data', () => {
    it('is tried again as a create, under a key of its own state', () => {
      const retry = route(placed, 'awaiting_correction');

      expect(retry).toEqual({
        route: 'retry',
        jobType: 'order.create',
        idempotencyKey: `order.retry:${INTEGRATION_ID}:1001:processing:${String(placed.date_modified_gmt)}`,
      });
      // The create key is taken by the event that was skipped.
      expect(retry.idempotencyKey).not.toBe(route(placed).idempotencyKey);
    });

    it('tries one state of the order once, and a changed order again', () => {
      const first = route(placed, 'awaiting_correction');
      const repeated = route({ ...placed }, 'awaiting_correction');
      const changed = route(
        { ...placed, date_modified_gmt: '2026-01-01T10:05:00' },
        'awaiting_correction',
      );

      expect(repeated.idempotencyKey).toBe(first.idempotencyKey);
      expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    });

    it.each([
      ['a draft', { status: 'checkout-draft' }, 'order_not_placed'],
      ['a cancelled order', { status: 'cancelled' }, 'order_not_placed'],
      [
        'another payment method',
        { payment_method: 'bacs' },
        'non_cod_payment_method',
      ],
    ])('still starts nothing for %s', (_label, overrides, reason) => {
      expect(
        route({ ...placed, ...overrides }, 'awaiting_correction'),
      ).toMatchObject({ route: 'skipped', reason });
    });

    it('still starts nothing for an order older than the connection', () => {
      expect(
        route(placed, 'awaiting_correction', '2026-06-01T00:00:00.000Z'),
      ).toMatchObject({
        route: 'skipped',
        reason: 'order_predates_connection',
      });
    });
  });

  it('never starts an order older than the connection, on either path', () => {
    expect(route(placed, 'none', '2026-06-01T00:00:00.000Z')).toMatchObject({
      route: 'skipped',
      reason: 'order_predates_connection',
    });
  });

  it.each([
    ['a status with a space', { status: 'on hold' }],
    ['a status that is not text', { status: { a: 1 } }],
    ['a very long status', { status: 'x'.repeat(65) }],
    ['a control character', { status: `a${String.fromCharCode(10)}b` }],
    ['a missing modification date', { date_modified_gmt: undefined }],
  ])('keeps %s out of the key', (_label, overrides) => {
    const key = route({ ...placed, ...overrides }, 'taken').idempotencyKey;

    expect(key).toContain(':invalid');
    expect(key).toMatch(/^[\x21-\x7E]+$/);
    expect(key.length).toBeLessThan(200);
  });
});
