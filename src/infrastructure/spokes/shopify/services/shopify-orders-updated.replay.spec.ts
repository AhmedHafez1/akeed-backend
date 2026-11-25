import { ShopifyOrderWebhookService } from './shopify-order-webhook.service';
import { SHIPPING_NOTIFICATIONS_CONFIG } from '../../../../shared/config/shipping-notifications.config';
import type { ShopifyOrderUpdatedWebhookDto } from '../dto/shopify-webhooks.dto';
import {
  replayPayload,
  replayScenarios,
  type ReplayScenario,
} from '../../../../../test/fixtures/shipping-notifications/load-orders-updated';

/**
 * Replays the synthetic orders/updated fixtures through the webhook intake.
 * The producer fake keeps the delivery-id dedupe and the store admit check
 * of the real producer (covered by its own spec). Processing of the same
 * fixtures runs against PostgreSQL in the shipping-notifications contract.
 */

interface IngestCall {
  idempotencyKey: string;
  rawPayload: Record<string, unknown>;
  admit: (integration: {
    shippingNotificationsEnabled: boolean;
  }) => string | null;
}

const SHIPPING_FIELDS = [
  'id',
  'created_at',
  'updated_at',
  'cancelled_at',
  'test',
  'tags',
  'fulfillment_status',
  'fulfillments',
];

function intake(scenario: ReplayScenario) {
  const seen = new Set<string>();
  const stored: IngestCall[] = [];
  const outcomes: { stored: boolean; duplicate: boolean }[] = [];
  const ingest = jest.fn((call: IngestCall) => {
    if (seen.has(call.idempotencyKey)) {
      outcomes.push({ stored: false, duplicate: true });
      return Promise.resolve({ enqueued: false, duplicate: true });
    }
    if (
      call.admit({ shippingNotificationsEnabled: scenario.store.enabled }) !==
      null
    ) {
      outcomes.push({ stored: false, duplicate: false });
      return Promise.resolve({ enqueued: false });
    }
    seen.add(call.idempotencyKey);
    stored.push(call);
    outcomes.push({ stored: true, duplicate: false });
    return Promise.resolve({ enqueued: true });
  });
  const config = {
    get: (key: string) =>
      key === SHIPPING_NOTIFICATIONS_CONFIG
        ? { enabled: scenario.envEnabled !== false }
        : undefined,
  };
  return {
    service: new ShopifyOrderWebhookService(
      { ingest } as never,
      config as never,
    ),
    ingest,
    stored,
    outcomes,
  };
}

describe('orders/updated replay fixtures: webhook intake', () => {
  it.each(replayScenarios().map((scenario) => [scenario.name, scenario]))(
    '%s',
    async (_name, scenario) => {
      const { service, ingest, stored, outcomes } = intake(scenario);
      for (const delivery of scenario.deliveries) {
        const payload = replayPayload(delivery, '820982911946154508');
        await expect(
          service.handleOrderUpdated(
            payload as unknown as ShopifyOrderUpdatedWebhookDto,
            'replay.myshopify.com',
            delivery.webhookId,
          ),
        ).resolves.toMatchObject({ received: true });
        if (scenario.envEnabled === false)
          outcomes.push({ stored: false, duplicate: false });
      }

      expect(outcomes).toEqual(scenario.intake);
      if (scenario.envEnabled === false) expect(ingest).not.toHaveBeenCalled();
      for (const call of stored) {
        expect(scenario.deliveries.map((d) => d.webhookId)).toContain(
          call.idempotencyKey,
        );
        expect(
          Object.keys(call.rawPayload).every((key) =>
            SHIPPING_FIELDS.includes(key),
          ),
        ).toBe(true);
      }
    },
  );

  it('covers every scenario the story names', () => {
    expect(replayScenarios().map((scenario) => scenario.name)).toEqual(
      expect.arrayContaining([
        'fulfilled with tracking',
        'fulfilled without tracking',
        'tag added after fulfillment',
        'duplicate delivery',
        'out-of-order delivery',
        'Akeed tag echo',
        'cancelled in Shopify',
        '31-day-old order',
        'unknown order',
        'feature off for the store',
        'env switch off',
      ]),
    );
  });
});
