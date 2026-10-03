import type { CommerceOutcomeSyncsRepository } from '../../database/repositories/commerce-outcome-syncs.repository';
import type { OrdersRepository } from '../../database/repositories/orders.repository';
import {
  easyOrdersStatusFor,
  readEasyOrdersStatus,
} from './easyorders-outcome.mapping';
import { EasyOrdersStatusUpdateHandler } from './easyorders-status-update.handler';

function setup(
  options: {
    order?: { id: string } | null;
    syncs?: Array<{ action: string; state: string }>;
  } = {},
) {
  const orders = {
    findBySourceExternalId: jest
      .fn()
      .mockResolvedValue(
        options.order === null ? undefined : (options.order ?? { id: 'o-1' }),
      ),
  };
  const syncs = {
    findForOrder: jest.fn().mockResolvedValue(options.syncs ?? []),
  };
  const handler = new EasyOrdersStatusUpdateHandler(
    orders as unknown as OrdersRepository,
    syncs as unknown as CommerceOutcomeSyncsRepository,
  );
  const handle = (payload: Record<string, unknown>) =>
    handler.handleOrderUpdate(payload, 'integration-1', 'org-1');
  return { handle, orders, syncs };
}

const event = (newStatus: unknown, orderId: unknown = 'order-1') => ({
  event_type: 'order-status-update',
  order_id: orderId,
  old_status: 'pending',
  new_status: newStatus,
});

describe('EasyOrdersStatusUpdateHandler', () => {
  it('looks the order up under the integration the token resolved to', async () => {
    const { handle, orders, syncs } = setup();

    await handle({ ...event('confirmed'), store_id: 'other', org_id: 'evil' });

    expect(orders.findBySourceExternalId).toHaveBeenCalledWith({
      orgId: 'org-1',
      integrationId: 'integration-1',
      externalOrderId: 'order-1',
    });
    expect(syncs.findForOrder).toHaveBeenCalledWith(
      'org-1',
      'integration-1',
      'o-1',
    );
  });

  it('records and skips an order the integration does not own', async () => {
    const { handle, syncs } = setup({ order: null });

    await expect(handle(event('confirmed'))).resolves.toEqual({
      skipped: true,
      reason: 'order_not_owned',
    });
    expect(syncs.findForOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['succeeded', 'customer_confirmation', 'confirmed'],
    ['pending', 'customer_confirmation', 'confirmed'],
    ['failed', 'customer_cancellation', 'canceled'],
    ['succeeded', 'merchant_no_reply_cancellation', 'canceled'],
  ])(
    'recognizes its own %s %s coming back as %s',
    async (state, action, status) => {
      const { handle } = setup({ syncs: [{ action, state }] });

      await expect(handle(event(status))).resolves.toEqual({
        skipped: true,
        reason: 'reflected_outcome',
      });
    },
  );

  it.each([
    ['a status Akeed never wrote', [], 'delivered'],
    [
      'a different status than the one Akeed wrote',
      [{ action: 'customer_confirmation', state: 'succeeded' }],
      'canceled',
    ],
    [
      'an action that was never sent',
      [{ action: 'customer_confirmation', state: 'unsupported' }],
      'confirmed',
    ],
    [
      'a local-only no-reply',
      [{ action: 'automatic_no_reply_tagging', state: 'unsupported' }],
      'canceled',
    ],
  ])('only records %s', async (_name, syncs, status) => {
    const { handle } = setup({ syncs });

    await expect(handle(event(status))).resolves.toEqual({
      skipped: true,
      reason: 'remote_status_observed',
    });
  });

  it.each([
    [event('confirmed', 42)],
    [event('confirmed', '')],
    [event(undefined)],
    [event('not a status')],
  ])('skips a malformed event without a lookup %#', async (payload) => {
    const { handle, orders } = setup();

    await expect(handle(payload)).resolves.toEqual({
      skipped: true,
      reason: 'malformed_status_event',
    });
    expect(orders.findBySourceExternalId).not.toHaveBeenCalled();
  });
});

describe('EasyOrders outcome mapping', () => {
  it.each([
    ['customer_confirmation', 'confirmed'],
    ['customer_cancellation', 'canceled'],
    ['merchant_no_reply_cancellation', 'canceled'],
    ['automatic_no_reply_tagging', undefined],
    ['merchant_cancellation_tagging', undefined],
    ['toString', undefined],
  ])('%s -> %s', (action, status) => {
    expect(easyOrdersStatusFor(action)).toBe(status);
  });

  it('reads only a status name', () => {
    expect(readEasyOrdersStatus('waiting_for_pickup')).toBe(
      'waiting_for_pickup',
    );
    expect(readEasyOrdersStatus('two words')).toBeNull();
    expect(readEasyOrdersStatus('')).toBeNull();
    expect(readEasyOrdersStatus('x'.repeat(65))).toBeNull();
    expect(readEasyOrdersStatus(7)).toBeNull();
  });
});
