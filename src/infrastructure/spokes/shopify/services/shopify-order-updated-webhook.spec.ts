import { ShopifyOrderWebhookService } from './shopify-order-webhook.service';
import { WebhookJobType } from '../../../../modules/webhook-queue/webhook-queue.constants';
import { SHIPPING_NOTIFICATIONS_CONFIG } from '../../../../shared/config/shipping-notifications.config';
import type { ShopifyOrderUpdatedWebhookDto } from '../dto/shopify-webhooks.dto';

interface IngestCall {
  idempotencyKey: string;
  admit: (integration: unknown) => string | null;
}

function setup(enabled: boolean) {
  const ingest = jest
    .fn<Promise<{ enqueued: boolean }>, [IngestCall]>()
    .mockResolvedValue({ enqueued: true });
  const config = {
    get: jest.fn((key: string) =>
      key === SHIPPING_NOTIFICATIONS_CONFIG ? { enabled } : undefined,
    ),
  };
  const service = new ShopifyOrderWebhookService(
    { ingest } as never,
    config as never,
  );
  return { service, ingest };
}

const payload = {
  id: '820982911946154508',
  created_at: '2026-11-20T10:00:00+02:00',
  updated_at: '2026-11-21T10:00:00+02:00',
  cancelled_at: null,
  test: false,
  tags: 'shipped',
  fulfillment_status: 'fulfilled',
  fulfillments: [{ status: 'success', tracking_number: 'N1' }],
  customer: { phone: '+201000000000' },
} as unknown as ShopifyOrderUpdatedWebhookDto;

describe('ShopifyOrderWebhookService.handleOrderUpdated', () => {
  it('acknowledges without storing while the switch is off', async () => {
    const { service, ingest } = setup(false);
    await expect(
      service.handleOrderUpdated(payload, 'shop.myshopify.com', 'w-1'),
    ).resolves.toEqual({ received: true });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('acknowledges a test order without storing it', async () => {
    const { service, ingest } = setup(true);
    await service.handleOrderUpdated(
      { ...payload, test: true } as ShopifyOrderUpdatedWebhookDto,
      'shop.myshopify.com',
      'w-1',
    );
    expect(ingest).not.toHaveBeenCalled();
  });

  it('stores only the shipping fields, keyed by the delivery id', async () => {
    const { service, ingest } = setup(true);
    await service.handleOrderUpdated(payload, 'Shop.MyShopify.com', ' w-1 ');
    expect(ingest).toHaveBeenCalledWith({
      platform: 'shopify',
      jobType: WebhookJobType.ORDER_UPDATE,
      idempotencyKey: 'w-1',
      storeDomain: 'shop.myshopify.com',
      rawPayload: {
        id: '820982911946154508',
        created_at: '2026-11-20T10:00:00+02:00',
        updated_at: '2026-11-21T10:00:00+02:00',
        cancelled_at: null,
        test: false,
        tags: 'shipped',
        fulfillment_status: 'fulfilled',
        fulfillments: [{ status: 'success', tracking_number: 'N1' }],
      },
      admit: expect.any(Function) as unknown,
    });
  });

  it('falls back to the order id and update time without a delivery id', async () => {
    const { service, ingest } = setup(true);
    await service.handleOrderUpdated(payload, 'shop.myshopify.com', '');
    expect(ingest.mock.calls[0][0].idempotencyKey).toBe(
      'fallback:order.update:820982911946154508:2026-11-21T10:00:00+02:00',
    );
  });

  it('admits only stores that switched shipping notifications on', async () => {
    const { service, ingest } = setup(true);
    await service.handleOrderUpdated(payload, 'shop.myshopify.com', 'w-1');
    const { admit } = ingest.mock.calls[0][0];
    expect(admit({ shippingNotificationsEnabled: true })).toBeNull();
    expect(admit({ shippingNotificationsEnabled: false })).toBe(
      'shipping_feature_off',
    );
  });

  it.each([
    ['evil.example.com', '1'],
    ['shop.myshopify.com', ''],
  ])('refuses a bad identity: %s / %s', async (shop, id) => {
    const { service } = setup(true);
    await expect(
      service.handleOrderUpdated(
        { ...payload, id } as ShopifyOrderUpdatedWebhookDto,
        shop,
        'w-1',
      ),
    ).rejects.toMatchObject({
      response: { code: 'SHOPIFY_WEBHOOK_IDENTITY_INVALID' },
    });
  });
});
