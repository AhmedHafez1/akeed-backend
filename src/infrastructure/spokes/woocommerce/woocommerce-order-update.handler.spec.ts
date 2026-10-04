import type { CommerceOutcomeSyncsRepository } from '../../database/repositories/commerce-outcome-syncs.repository';
import type { OrdersRepository } from '../../database/repositories/orders.repository';
import { orderUpdatedFixture } from '../../../../test/fixtures/woocommerce/load';
import { toStoredWooCommerceDelivery } from './woocommerce-delivery';
import { WooCommerceOrderUpdateHandler } from './woocommerce-order-update.handler';

const ORG_ID = 'org-1';
const INTEGRATION_ID = 'integration-1';
const VERIFICATION_ID = 'verification-1';

interface Outcome {
  action: string;
  state: string;
  correlationId: string;
}

function setup(
  options: { order?: { id: string } | null; outcomes?: Outcome[] } = {},
) {
  const orders = {
    findBySourceExternalId: jest
      .fn()
      .mockResolvedValue(
        options.order === null
          ? undefined
          : (options.order ?? { id: 'order-1' }),
      ),
  };
  const syncs = {
    findForOrder: jest.fn().mockResolvedValue(options.outcomes ?? []),
  };
  const handler = new WooCommerceOrderUpdateHandler(
    orders as unknown as OrdersRepository,
    syncs as unknown as CommerceOutcomeSyncsRepository,
  );
  return { handler, orders, syncs };
}

/** An `order.updated` delivery as the webhook service stores it. */
function update(
  status: unknown,
  markers: string[] = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { payload } = orderUpdatedFixture();
  return {
    ...toStoredWooCommerceDelivery(
      { topic: 'order.updated', webhookId: '9002', deliveryId: 'delivery-1' },
      {
        ...payload,
        status,
        meta_data: [
          { id: 1, key: '_other_plugin', value: 'ignored' },
          ...markers.map((value, index) => ({
            id: index + 2,
            key: 'akeed_outcome',
            value,
          })),
        ],
        ...overrides,
      },
    ),
  };
}

const outcome = (
  action: string,
  state = 'succeeded',
  correlationId = VERIFICATION_ID,
): Outcome => ({ action, state, correlationId });

describe('WooCommerceOrderUpdateHandler', () => {
  it('handles woocommerce updates', () => {
    expect(setup().handler.platform).toBe('woocommerce');
  });

  describe('Akeed’s own write coming back', () => {
    it.each([
      ['customer_confirmation', 'processing'],
      ['customer_confirmation', 'on-hold'],
      ['customer_cancellation', 'cancelled'],
      ['merchant_no_reply_cancellation', 'cancelled'],
    ])('recognizes the echo of %s in %s', async (action, status) => {
      const { handler } = setup({ outcomes: [outcome(action)] });

      await expect(
        handler.handleOrderUpdate(
          update(status, [`${action}:${VERIFICATION_ID}`]),
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).resolves.toEqual({ skipped: true, reason: 'reflected_outcome' });
    });

    it.each(['pending', 'failed'])(
      'counts a %s row too: the write may have been taken',
      async (state) => {
        const { handler } = setup({
          outcomes: [outcome('customer_cancellation', state)],
        });

        await expect(
          handler.handleOrderUpdate(
            update('cancelled', [`customer_cancellation:${VERIFICATION_ID}`]),
            INTEGRATION_ID,
            ORG_ID,
          ),
        ).resolves.toEqual({ skipped: true, reason: 'reflected_outcome' });
      },
    );

    it('finds the marker among several akeed_outcome entries', async () => {
      const { handler } = setup({
        outcomes: [outcome('customer_cancellation')],
      });

      await expect(
        handler.handleOrderUpdate(
          update('cancelled', [
            'customer_confirmation:an-older-verification',
            `customer_cancellation:${VERIFICATION_ID}`,
          ]),
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).resolves.toEqual({ skipped: true, reason: 'reflected_outcome' });
    });
  });

  describe('a change the merchant made', () => {
    it('only observes the documented update fixture: no marker on it', async () => {
      const { handler, syncs } = setup({
        outcomes: [outcome('customer_confirmation')],
      });
      const { payload } = orderUpdatedFixture();

      await expect(
        handler.handleOrderUpdate(
          {
            ...toStoredWooCommerceDelivery({ topic: 'order.updated' }, payload),
          },
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).resolves.toEqual({ skipped: true, reason: 'remote_status_observed' });
      expect(syncs.findForOrder).not.toHaveBeenCalled();
    });

    it.each([
      // The marker stays on the order after Akeed's write.
      ['customer_confirmation', 'completed'],
      ['customer_confirmation', 'cancelled'],
      ['customer_confirmation', 'refunded'],
      ['customer_cancellation', 'processing'],
      ['merchant_no_reply_cancellation', 'on-hold'],
      ['customer_cancellation', 'wc-custom-status'],
    ])('observes %s moved on to %s, marker or not', async (action, status) => {
      const { handler } = setup({ outcomes: [outcome(action)] });

      await expect(
        handler.handleOrderUpdate(
          update(status, [`${action}:${VERIFICATION_ID}`]),
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).resolves.toEqual({ skipped: true, reason: 'remote_status_observed' });
    });

    it('observes a cancelled order Akeed recorded no outcome for', async () => {
      const { handler } = setup({ outcomes: [] });

      await expect(
        handler.handleOrderUpdate(
          update('cancelled', [`customer_cancellation:${VERIFICATION_ID}`]),
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).resolves.toEqual({ skipped: true, reason: 'remote_status_observed' });
    });

    it('does not take a marker of another verification as its own', async () => {
      const { handler } = setup({
        outcomes: [outcome('customer_cancellation')],
      });

      await expect(
        handler.handleOrderUpdate(
          update('cancelled', ['customer_cancellation:someone-else']),
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).resolves.toEqual({ skipped: true, reason: 'remote_status_observed' });
    });

    it('does not take a marker of an action Akeed never sent as its own', async () => {
      const { handler } = setup({
        outcomes: [outcome('automatic_no_reply_tagging', 'unsupported')],
      });

      await expect(
        handler.handleOrderUpdate(
          update('cancelled', [
            `automatic_no_reply_tagging:${VERIFICATION_ID}`,
            `customer_cancellation:${VERIFICATION_ID}`,
          ]),
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).resolves.toEqual({ skipped: true, reason: 'remote_status_observed' });
    });

    it('observes an update whose status is not a status name', async () => {
      const { handler, syncs } = setup({
        outcomes: [outcome('customer_confirmation')],
      });

      await expect(
        handler.handleOrderUpdate(
          update('on its way', [`customer_confirmation:${VERIFICATION_ID}`]),
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).resolves.toEqual({ skipped: true, reason: 'remote_status_observed' });
      expect(syncs.findForOrder).not.toHaveBeenCalled();
    });
  });

  describe('tenant scope', () => {
    it('looks the order up under the integration the delivery was accepted for', async () => {
      const { handler, orders, syncs } = setup({
        outcomes: [outcome('customer_cancellation')],
      });

      await handler.handleOrderUpdate(
        update('cancelled', [`customer_cancellation:${VERIFICATION_ID}`]),
        INTEGRATION_ID,
        ORG_ID,
      );

      expect(orders.findBySourceExternalId).toHaveBeenCalledWith({
        orgId: ORG_ID,
        integrationId: INTEGRATION_ID,
        externalOrderId: '1001',
      });
      expect(syncs.findForOrder).toHaveBeenCalledWith(
        ORG_ID,
        INTEGRATION_ID,
        'order-1',
      );
    });

    it('changes nothing for an order this integration does not have', async () => {
      const { handler, syncs } = setup({ order: null });

      await expect(
        handler.handleOrderUpdate(
          update('cancelled', [`customer_cancellation:${VERIFICATION_ID}`]),
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).resolves.toEqual({ skipped: true, reason: 'order_not_owned' });
      expect(syncs.findForOrder).not.toHaveBeenCalled();
    });
  });

  describe('malformed events', () => {
    it.each([
      ['no order', {}],
      ['an order that is not an object', { order: 'x' }],
      ['no order id', { order: { status: 'cancelled' } }],
      ['a text order id', { order: { id: '1001', status: 'cancelled' } }],
      ['a zero order id', { order: { id: 0, status: 'cancelled' } }],
    ])('records %s and looks nothing up', async (_label, rawPayload) => {
      const { handler, orders } = setup();

      await expect(
        handler.handleOrderUpdate(rawPayload, INTEGRATION_ID, ORG_ID),
      ).resolves.toEqual({ skipped: true, reason: 'malformed_update_event' });
      expect(orders.findBySourceExternalId).not.toHaveBeenCalled();
    });
  });

  it('never returns handled: an update causes nothing', async () => {
    const { handler } = setup({ outcomes: [outcome('customer_confirmation')] });

    for (const status of ['processing', 'completed', 'cancelled'])
      expect(
        await handler.handleOrderUpdate(
          update(status, [`customer_confirmation:${VERIFICATION_ID}`]),
          INTEGRATION_ID,
          ORG_ID,
        ),
      ).toHaveProperty('skipped', true);
  });
});
