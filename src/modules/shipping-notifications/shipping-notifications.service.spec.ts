import { ShippingNotificationsService } from './shipping-notifications.service';
import type { ShippingEventSource } from './shipping-event-source';
import type {
  ShippingNotificationInsert,
  ShippingNotificationRow,
  ShippingOrderContext,
} from '../../infrastructure/database/repositories/shipping-notifications.repository';
import { SHIPPING_NOTIFICATIONS_CONFIG } from '../../shared/config/shipping-notifications.config';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

const DAY = 24 * 60 * 60 * 1000;
const EVENT = {
  platform: 'shopify' as const,
  orgId: 'org-1',
  integrationId: 'int-1',
  rawPayload: { id: '1001' },
};

function context(
  overrides: Partial<ShippingOrderContext> = {},
): ShippingOrderContext {
  return {
    verificationId: 'ver-1',
    verificationStatus: 'confirmed',
    verificationCanceledAt: null,
    merchantCanceledAt: null,
    orderIsTest: false,
    orderCreatedAt: new Date(Date.now() - DAY).toISOString(),
    shippingNotificationsEnabled: true,
    shippingFulfillmentTriggerEnabled: true,
    shippingTags: [],
    ...overrides,
  };
}

/** An in-memory record table with the unique (verification, stage) key. */
function fakeRepository(ctx: ShippingOrderContext | null) {
  const rows = new Map<string, ShippingNotificationRow>();
  let next = 1;
  return {
    rows,
    findShippingContext: jest.fn().mockResolvedValue(ctx),
    insertIfNew: jest.fn((row: ShippingNotificationInsert) => {
      const key = `${row.verificationId}|${row.stage}`;
      if (rows.has(key)) return Promise.resolve(null);
      const inserted = {
        id: `ship-${next++}`,
        matchedTag: null,
        trackingNumber: null,
        trackingUrl: null,
        reasonCode: null,
        dispatchId: null,
        customerReply: null,
        status: 'pending',
        createdAt: '',
        updatedAt: '',
        ...row,
      } as ShippingNotificationRow;
      rows.set(key, inserted);
      return Promise.resolve(inserted);
    }),
    findByVerification: jest.fn(
      (p: { verificationId: string; stage: string }) =>
        Promise.resolve(rows.get(`${p.verificationId}|${p.stage}`) ?? null),
    ),
  };
}

function source(
  overrides: Partial<ShippingEventSource> = {},
): ShippingEventSource {
  return {
    platform: 'shopify',
    readOrderRef: jest.fn(() => ({
      externalOrderId: '1001',
      sourceCreatedAt: new Date(Date.now() - DAY).toISOString(),
      sourceCancelledAt: null,
      isTest: false,
    })),
    detect: jest.fn(() => ({
      stage: 'shipped' as const,
      trigger: 'fulfillment' as const,
      tracking: { number: 'N1', url: 'https://t.example/N1' },
    })),
    ...overrides,
  };
}

function setup(
  options: {
    enabled?: boolean;
    ctx?: ShippingOrderContext | null;
    src?: ShippingEventSource;
  } = {},
) {
  const repository = fakeRepository(
    options.ctx === undefined ? context() : options.ctx,
  );
  const automation = {
    enqueueShippingSend: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === SHIPPING_NOTIFICATIONS_CONFIG
        ? { enabled: options.enabled ?? true }
        : undefined,
    ),
  };
  const src = options.src ?? source();
  const service = new ShippingNotificationsService(
    [src],
    repository as any,
    automation as any,
    config as any,
  );
  return { service, repository, automation, src };
}

describe('ShippingNotificationsService', () => {
  it('records a pending notification and queues its send', async () => {
    const { service, repository, automation } = setup();
    await expect(service.handleStoreOrderUpdate(EVENT)).resolves.toEqual({
      handled: true,
    });
    expect(repository.insertIfNew).toHaveBeenCalledWith({
      orgId: 'org-1',
      verificationId: 'ver-1',
      stage: 'shipped',
      trigger: 'fulfillment',
      matchedTag: null,
      trackingNumber: 'N1',
      trackingUrl: 'https://t.example/N1',
      status: 'pending',
      reasonCode: null,
    });
    expect(automation.enqueueShippingSend).toHaveBeenCalledWith({
      verificationId: 'ver-1',
      orgId: 'org-1',
      shippingNotificationId: 'ship-1',
    });
    expect(repository.findShippingContext).toHaveBeenCalledWith({
      orgId: 'org-1',
      integrationId: 'int-1',
      externalOrderId: '1001',
    });
  });

  it('keeps one record when the same event is processed twice', async () => {
    const { service, repository, automation } = setup();
    await service.handleStoreOrderUpdate(EVENT);
    await expect(service.handleStoreOrderUpdate(EVENT)).resolves.toEqual({
      skipped: true,
      reason: 'already_recorded',
    });
    expect(repository.rows.size).toBe(1);
    // The second run only re-queues the pending record's fixed job id.
    expect(automation.enqueueShippingSend).toHaveBeenCalledTimes(2);
    expect(automation.enqueueShippingSend.mock.calls[1]).toEqual(
      automation.enqueueShippingSend.mock.calls[0],
    );
  });

  it('keeps the first record when a tag arrives after the fulfillment', async () => {
    const detect = jest
      .fn()
      .mockReturnValueOnce({ stage: 'shipped', trigger: 'fulfillment' })
      .mockReturnValueOnce({
        stage: 'shipped',
        trigger: 'tag',
        matchedTag: 'Shipped',
      });
    const { service, repository } = setup({ src: source({ detect }) });
    await service.handleStoreOrderUpdate(EVENT);
    await service.handleStoreOrderUpdate(EVENT);
    expect(repository.rows.size).toBe(1);
    expect([...repository.rows.values()][0].trigger).toBe('fulfillment');
  });

  it('does not re-queue a record that is no longer pending', async () => {
    const { service, repository, automation } = setup();
    await service.handleStoreOrderUpdate(EVENT);
    [...repository.rows.values()][0].status = 'sent';
    await service.handleStoreOrderUpdate(EVENT);
    expect(automation.enqueueShippingSend).toHaveBeenCalledTimes(1);
  });

  it('records a cancelled order as failed and queues nothing', async () => {
    const { service, repository, automation } = setup({
      ctx: context({ verificationStatus: 'canceled' }),
    });
    await service.handleStoreOrderUpdate(EVENT);
    expect(repository.insertIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        reasonCode: 'order_cancelled',
      }),
    );
    expect(automation.enqueueShippingSend).not.toHaveBeenCalled();
  });

  it('records an order cancelled in the store as failed', async () => {
    const src = source({
      readOrderRef: jest.fn(() => ({
        externalOrderId: '1001',
        sourceCreatedAt: null,
        sourceCancelledAt: '2026-11-20T00:00:00Z',
        isTest: false,
      })),
    });
    const { service, repository } = setup({ src });
    await service.handleStoreOrderUpdate(EVENT);
    expect(repository.insertIfNew).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'order_cancelled' }),
    );
  });

  it('records an order older than 30 days as failed', async () => {
    const src = source({
      readOrderRef: jest.fn(() => ({
        externalOrderId: '1001',
        sourceCreatedAt: new Date(Date.now() - 31 * DAY).toISOString(),
        sourceCancelledAt: null,
        isTest: false,
      })),
    });
    const { service, repository, automation } = setup({ src });
    await service.handleStoreOrderUpdate(EVENT);
    expect(repository.insertIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        reasonCode: 'order_too_old',
      }),
    );
    expect(automation.enqueueShippingSend).not.toHaveBeenCalled();
  });

  it.each([
    ['the env switch is off', { enabled: false }, 'shipping_disabled'],
    ['Akeed has no verification', { ctx: null }, 'order_not_owned'],
    [
      'the store has the feature off',
      { ctx: context({ shippingNotificationsEnabled: false }) },
      'shipping_feature_off',
    ],
    [
      'the order is a test',
      { ctx: context({ orderIsTest: true }) },
      'test_order',
    ],
    [
      'the event shows no shipping',
      { src: source({ detect: jest.fn(() => null) }) },
      'no_shipping_signal',
    ],
    [
      'the payload has no order id',
      { src: source({ readOrderRef: jest.fn(() => null) }) },
      'malformed_order_event',
    ],
  ])('drops the event when %s', async (_label, options, reason) => {
    const { service, repository, automation } = setup(options);
    await expect(service.handleStoreOrderUpdate(EVENT)).resolves.toEqual({
      skipped: true,
      reason,
    });
    expect(repository.insertIfNew).not.toHaveBeenCalled();
    expect(automation.enqueueShippingSend).not.toHaveBeenCalled();
  });

  it('stops after the one context lookup for an unknown order', async () => {
    const detect = jest.fn(() => null);
    const { service, repository } = setup({
      ctx: null,
      src: source({ detect }),
    });
    await service.handleStoreOrderUpdate(EVENT);
    expect(repository.findShippingContext).toHaveBeenCalledTimes(1);
    expect(detect).not.toHaveBeenCalled();
  });

  it('drops events from a platform without a source', async () => {
    const { service, repository } = setup();
    await expect(
      service.handleStoreOrderUpdate({ ...EVENT, platform: 'woocommerce' }),
    ).resolves.toEqual({
      skipped: true,
      reason: 'shipping_source_unsupported',
    });
    expect(repository.findShippingContext).not.toHaveBeenCalled();
  });

  it('passes the store settings to the source', async () => {
    const detect = jest.fn(() => null);
    const { service } = setup({
      src: source({ detect }),
      ctx: context({
        shippingFulfillmentTriggerEnabled: false,
        shippingTags: ['شحن'],
      }),
    });
    await service.handleStoreOrderUpdate(EVENT);
    expect(detect).toHaveBeenCalledWith(EVENT.rawPayload, {
      fulfillmentTriggerEnabled: false,
      tags: ['شحن'],
    });
  });

  it('fails the job when the send cannot be queued, so the webhook retries', async () => {
    const { service, automation, repository } = setup();
    automation.enqueueShippingSend.mockRejectedValueOnce(new Error('redis'));
    await expect(service.handleStoreOrderUpdate(EVENT)).rejects.toThrow(
      'redis',
    );
    // The retry finds the pending record and queues it.
    await expect(service.handleStoreOrderUpdate(EVENT)).resolves.toEqual({
      skipped: true,
      reason: 'already_recorded',
    });
    expect(repository.rows.size).toBe(1);
    expect(automation.enqueueShippingSend).toHaveBeenCalledTimes(2);
  });

  it('builds one order-update handler per registered platform', async () => {
    const { service, repository } = setup();
    const handlers = service.orderUpdateHandlers();
    expect(handlers.map((h) => h.platform)).toEqual(['shopify']);
    await handlers[0].handleOrderUpdate({ id: '1001' }, 'int-1', 'org-1');
    expect(repository.findShippingContext).toHaveBeenCalledWith({
      orgId: 'org-1',
      integrationId: 'int-1',
      externalOrderId: '1001',
    });
  });

  it('is available only with the switch on and a source for the platform', () => {
    expect(setup().service.isAvailableFor('shopify')).toBe(true);
    expect(setup().service.isAvailableFor('standalone')).toBe(false);
    expect(setup({ enabled: false }).service.isAvailableFor('shopify')).toBe(
      false,
    );
  });
});
