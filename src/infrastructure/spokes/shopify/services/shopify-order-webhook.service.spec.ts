import { ShopifyOrderWebhookService } from './shopify-order-webhook.service';
import { WebhookJobType } from '../../../../modules/webhook-queue/webhook-queue.constants';
import { ShopifyOrderWebhookDto } from '../dto/shopify-webhooks.dto';

describe('ShopifyOrderWebhookService', () => {
  const payload: ShopifyOrderWebhookDto = { id: '12345', order_number: '1001' };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  it.each([false, true])(
    'acknowledges duplicate=%s without changing the response contract',
    async (duplicate) => {
      const ingest = jest
        .fn()
        .mockResolvedValue(
          duplicate ? { enqueued: false, duplicate: true } : { enqueued: true },
        );
      const service = new ShopifyOrderWebhookService(
        { ingest } as never,
        config as never,
      );
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

  it('uses a deterministic order identity when the delivery ID is missing', async () => {
    const ingest = jest.fn().mockResolvedValue({ enqueued: true });
    const service = new ShopifyOrderWebhookService(
      { ingest } as never,
      config as never,
    );
    await service.handleOrderCreate(
      payload,
      'synthetic.myshopify.com',
      '',
      'orders/create',
    );
    expect(ingest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: 'fallback:order.create:12345',
      }),
    );
    await service.handleOrderCreate(
      payload,
      'synthetic.myshopify.com',
      '',
      'orders/create',
    );
    expect(ingest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: 'fallback:order.create:12345',
      }),
    );
  });

  it('rejects a missing source or event identity before durable acceptance', async () => {
    const ingest = jest.fn();
    const service = new ShopifyOrderWebhookService(
      { ingest } as never,
      config as never,
    );
    await expect(
      service.handleOrderCreate(
        { ...payload, id: '' },
        'synthetic.myshopify.com',
        '',
        'orders/create',
      ),
    ).rejects.toThrow('provider order ID');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('propagates ingestion failure rather than returning an acknowledgement', async () => {
    const service = new ShopifyOrderWebhookService(
      {
        ingest: jest.fn().mockRejectedValue(new Error('enqueue failed')),
      } as never,
      config as never,
    );
    await expect(
      service.handleOrderCreate(
        payload,
        'synthetic.myshopify.com',
        'delivery-1',
        'orders/create',
      ),
    ).rejects.toThrow('enqueue failed');
  });

  it('only ingests test orders when explicitly enabled', async () => {
    const ingest = jest.fn().mockResolvedValue({ enqueued: true });
    const disabled = new ShopifyOrderWebhookService(
      { ingest } as never,
      { get: jest.fn().mockReturnValue('false') } as never,
    );
    await expect(
      disabled.handleOrderCreate(
        { ...payload, test: true },
        'synthetic.myshopify.com',
        'test-delivery',
        'orders/create',
      ),
    ).resolves.toEqual({ received: true });
    expect(ingest).not.toHaveBeenCalled();

    const enabled = new ShopifyOrderWebhookService(
      { ingest } as never,
      { get: jest.fn().mockReturnValue('true') } as never,
    );
    await enabled.handleOrderCreate(
      { ...payload, test: true },
      'synthetic.myshopify.com',
      'test-delivery',
      'orders/create',
    );
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});
