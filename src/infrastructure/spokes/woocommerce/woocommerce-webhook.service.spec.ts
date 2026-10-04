import { HttpException } from '@nestjs/common';
import type { WooCommerceConnectionsRepository } from '../../database/repositories/woocommerce-connections.repository';
import { hashInstallToken } from './woocommerce-install-token';
import {
  isOrderDeliveryTopic,
  WooCommerceWebhookService,
} from './woocommerce-webhook.service';

const TOKEN = 'w'.repeat(43);

function createService(known: boolean) {
  const isKnownWebhookToken = jest.fn().mockResolvedValue(known);
  const service = new WooCommerceWebhookService({
    isKnownWebhookToken,
  } as unknown as WooCommerceConnectionsRepository);
  return { service, isKnownWebhookToken };
}

async function answerOf(promise: Promise<void>) {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return {
      status: error.getStatus(),
      code: (error.getResponse() as { code: string }).code,
    };
  }
}

const NOT_FOUND = { status: 404, code: 'WOOCOMMERCE_INGESTION_UNAVAILABLE' };

describe('isOrderDeliveryTopic', () => {
  it.each(['order.created', 'order.updated'])(
    '%s is an order delivery',
    (topic) => {
      expect(isOrderDeliveryTopic(topic)).toBe(true);
    },
  );

  it.each([
    undefined,
    null,
    '',
    'order.deleted',
    'action.woocommerce_ping',
    'ORDER.CREATED',
    ' order.created',
    ['order.created'],
  ])('%p is not', (topic) => {
    expect(isOrderDeliveryTopic(topic)).toBe(false);
  });
});

describe('WooCommerceWebhookService before ingestion', () => {
  it.each([undefined, '', 'action.woocommerce_ping', 'order.deleted'])(
    'answers a request with topic %p on a known token as the ping',
    async (topic) => {
      const { service, isKnownWebhookToken } = createService(true);

      await expect(
        answerOf(service.handleDelivery(TOKEN, topic)),
      ).resolves.toBe(200);
      // Looked up by hash; the token itself goes nowhere.
      expect(isKnownWebhookToken).toHaveBeenCalledWith(hashInstallToken(TOKEN));
    },
  );

  it.each(['order.created', 'order.updated'])(
    'answers an %s delivery as not found, without looking the token up',
    async (topic) => {
      const { service, isKnownWebhookToken } = createService(true);

      await expect(
        answerOf(service.handleDelivery(TOKEN, topic)),
      ).resolves.toEqual(NOT_FOUND);
      expect(isKnownWebhookToken).not.toHaveBeenCalled();
    },
  );

  it('answers an unknown token as not found', async () => {
    const { service } = createService(false);

    await expect(
      answerOf(service.handleDelivery(TOKEN, undefined)),
    ).resolves.toEqual(NOT_FOUND);
  });

  it.each(['', 'short', `${'w'.repeat(42)}/`, 'w'.repeat(44)])(
    'never takes the malformed token %p to the database',
    async (token) => {
      const { service, isKnownWebhookToken } = createService(true);

      await expect(
        answerOf(service.handleDelivery(token, undefined)),
      ).resolves.toEqual(NOT_FOUND);
      expect(isKnownWebhookToken).not.toHaveBeenCalled();
    },
  );
});
