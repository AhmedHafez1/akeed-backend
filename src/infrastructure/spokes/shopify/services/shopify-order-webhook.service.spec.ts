import { ShopifyOrderWebhookService } from './shopify-order-webhook.service';
import { WebhookJobType } from '../../../../modules/webhook-queue/webhook-queue.constants';
import { ShopifyOrderWebhookDto } from '../dto/shopify-webhooks.dto';

describe('ShopifyOrderWebhookService', () => {
  const payload: ShopifyOrderWebhookDto = { id: '12345', order_number: '1001' };
  afterEach(() => jest.useRealTimers());

  it.each([false, true])(
    'acknowledges duplicate=%s without changing the response contract',
    async (duplicate) => {
      const ingest = jest
        .fn()
        .mockResolvedValue(
          duplicate ? { enqueued: false, duplicate: true } : { enqueued: true },
        );
      const service = new ShopifyOrderWebhookService({ ingest } as never);
      await expect(
        service.handleOrderCreate(
          payload,
          'synthetic.myshopify.com',
          'delivery-1',
          'orders/create',
        ),
      ).resolves.toEqual(
        duplicate ? { received: true, duplicate: true } : { received: true },
      );
      expect(ingest).toHaveBeenCalledWith({
        platform: 'shopify',
        jobType: WebhookJobType.ORDER_CREATE,
        idempotencyKey: 'delivery-1',
        storeDomain: 'synthetic.myshopify.com',
        rawPayload: payload,
      });
    },
  );

  it('uses timestamp fallback for missing delivery IDs; later retries get different keys', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
    const ingest = jest.fn().mockResolvedValue({ enqueued: true });
    const service = new ShopifyOrderWebhookService({ ingest } as never);
    await service.handleOrderCreate(
      payload,
      'synthetic.myshopify.com',
      '',
      'orders/create',
    );
    expect(ingest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: 'shopify-order-12345-1778803200000',
      }),
    );
    jest.advanceTimersByTime(1);
    await service.handleOrderCreate(
      payload,
      'synthetic.myshopify.com',
      '',
      'orders/create',
    );
    expect(ingest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: 'shopify-order-12345-1778803200001',
      }),
    );
  });

  it('propagates ingestion failure rather than returning an acknowledgement', async () => {
    const service = new ShopifyOrderWebhookService({
      ingest: jest.fn().mockRejectedValue(new Error('enqueue failed')),
    } as never);
    await expect(
      service.handleOrderCreate(
        payload,
        'synthetic.myshopify.com',
        'delivery-1',
        'orders/create',
      ),
    ).rejects.toThrow('enqueue failed');
  });
});
