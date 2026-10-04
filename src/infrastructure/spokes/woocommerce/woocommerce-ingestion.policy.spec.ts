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
  parseWooCommerceGmtDate,
  readWooCommerceOrderId,
  routeWooCommerceDelivery,
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

describe('routeWooCommerceDelivery', () => {
  const route = (
    order: Record<string, unknown>,
    hasCreateEvent = false,
    connectedAt = CONNECTED_AT,
  ) =>
    routeWooCommerceDelivery({
      integrationId: INTEGRATION_ID,
      orderId: '1001',
      order,
      connectedAt,
      hasCreateEvent,
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
    expect(route(orderUpdatedFixture().payload, true)).toEqual({
      route: 'update',
      jobType: 'order.update',
      idempotencyKey: `order.update:${INTEGRATION_ID}:1001:completed:2026-01-02T07:30:00`,
    });
    // Even one that would start a verification on its own.
    expect(route(placed, true).route).toBe('update');
  });

  it('never starts an order older than the connection, on either path', () => {
    expect(route(placed, false, '2026-06-01T00:00:00.000Z')).toMatchObject({
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
    const key = route({ ...placed, ...overrides }, true).idempotencyKey;

    expect(key).toContain(':invalid');
    expect(key).toMatch(/^[\x21-\x7E]+$/);
    expect(key.length).toBeLessThan(200);
  });
});
