import {
  buildOrderCreatedKey,
  buildOrderStatusKey,
  EASYORDERS_STATUS_EVENT_TYPE,
  isEasyOrdersOpaqueId,
  isEasyOrdersOpaqueStatus,
  isRecord,
} from './easyorders-ingestion.policy';

describe('EasyOrders ingestion policy', () => {
  it('names the one documented status event type', () => {
    expect(EASYORDERS_STATUS_EVENT_TYPE).toBe('order-status-update');
  });

  it.each([null, undefined, 'text', 42, [], [{ id: '1' }]])(
    'does not take %p for a payload',
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );

  it('takes a plain object for a payload', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ id: '1' })).toBe(true);
  });

  it('accepts an id of printable characters up to 128 long', () => {
    expect(isEasyOrdersOpaqueId('a')).toBe(true);
    expect(isEasyOrdersOpaqueId('ord_123-ABC.~!')).toBe(true);
    expect(isEasyOrdersOpaqueId('a'.repeat(128))).toBe(true);
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'a'.repeat(129),
    'has space',
    `line${String.fromCharCode(0x0a)}break`,
    `tab${String.fromCharCode(0x09)}`,
    `caf${String.fromCharCode(0xe9)}`,
  ])('refuses %p as an id', (value) => {
    expect(isEasyOrdersOpaqueId(value)).toBe(false);
  });

  it('holds a status to 64 characters', () => {
    expect(isEasyOrdersOpaqueStatus('pending')).toBe(true);
    expect(isEasyOrdersOpaqueStatus('a'.repeat(64))).toBe(true);
    expect(isEasyOrdersOpaqueStatus('a'.repeat(65))).toBe(false);
    expect(isEasyOrdersOpaqueStatus('paid in full')).toBe(false);
    expect(isEasyOrdersOpaqueStatus('')).toBe(false);
  });

  it('scopes the create key to the integration and the order', () => {
    expect(buildOrderCreatedKey('integration-1', 'order-9')).toBe(
      'order.create:integration-1:order-9',
    );
    expect(buildOrderCreatedKey('integration-2', 'order-9')).not.toBe(
      buildOrderCreatedKey('integration-1', 'order-9'),
    );
  });

  it('keys a status event on the order and both statuses', () => {
    const event = {
      orderId: 'order-9',
      oldStatus: 'pending',
      newStatus: 'confirmed',
    };

    expect(buildOrderStatusKey('integration-1', event)).toBe(
      'order.status:integration-1:order-9:pending:confirmed',
    );
    expect(
      buildOrderStatusKey('integration-1', { ...event, newStatus: 'canceled' }),
    ).not.toBe(buildOrderStatusKey('integration-1', event));
  });
});
