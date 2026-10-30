import { PhoneService } from '../../../../shared/services/phone.service';
import { ShopifyGdprWebhookService } from './shopify-gdpr-webhook.service';
import { buildShopifyCustomerKeys } from './shopify-customer-keys';

describe('ShopifyGdprWebhookService customer requests', () => {
  const ordersRepo = {
    findShopifyCustomerOrders: jest.fn(),
    redactShopifyCustomer: jest.fn(),
    deleteByOrgId: jest.fn(),
  };
  const integrationsRepo = { findByPlatformDomain: jest.fn() };
  const webhookEventsRepo = {
    insertIfNew: jest.fn(),
    replaceRawPayload: jest.fn(),
    deleteByOrgId: jest.fn(),
  };
  const shopDomain = 'synthetic.myshopify.com';

  function service() {
    return new ShopifyGdprWebhookService(
      ordersRepo as never,
      {} as never,
      integrationsRepo as never,
      {} as never,
      {} as never,
      {} as never,
      webhookEventsRepo as never,
      new PhoneService(),
    );
  }

  beforeEach(() => {
    jest.resetAllMocks();
    integrationsRepo.findByPlatformDomain.mockResolvedValue({
      id: 'integration-1',
      orgId: 'org-1',
    });
    webhookEventsRepo.insertIfNew.mockResolvedValue({ id: 'event-1' });
    ordersRepo.redactShopifyCustomer.mockResolvedValue({
      orders: 2,
      verifications: 1,
      webhookEvents: 3,
    });
    ordersRepo.findShopifyCustomerOrders.mockResolvedValue([]);
  });

  it('redacts by customer id and order ids when the customer has no phone', async () => {
    await service().handleCustomerRedact(
      {
        customer: { id: '9177889997097', email: 'Redact@Example.com' },
        orders_to_redact: ['5001', '5002'],
      },
      shopDomain,
      'delivery-1',
      'customers/redact',
    );

    expect(ordersRepo.redactShopifyCustomer).toHaveBeenCalledWith(
      'org-1',
      'integration-1',
      {
        customerId: '9177889997097',
        email: 'Redact@Example.com',
        phones: [],
        externalOrderIds: ['5001', '5002'],
      },
    );
    expect(webhookEventsRepo.replaceRawPayload).toHaveBeenCalledWith(
      'event-1',
      {
        customer: { id: '9177889997097' },
        orders_to_redact: ['5001', '5002'],
      },
    );
  });

  it('skips without writing when the request names no one', async () => {
    await service().handleCustomerRedact(
      { customer: {} },
      shopDomain,
      'delivery-1',
      'customers/redact',
    );

    expect(ordersRepo.redactShopifyCustomer).not.toHaveBeenCalled();
    expect(webhookEventsRepo.replaceRawPayload).not.toHaveBeenCalled();
  });

  it('does nothing for a duplicate delivery', async () => {
    webhookEventsRepo.insertIfNew.mockResolvedValue(null);

    const ack = await service().handleCustomerRedact(
      { customer: { id: '1' } },
      shopDomain,
      'delivery-1',
      'customers/redact',
    );

    expect(ack).toEqual({ received: true, duplicate: true });
    expect(ordersRepo.redactShopifyCustomer).not.toHaveBeenCalled();
  });

  it('looks up a data request by customer id when the customer has no phone', async () => {
    await service().handleCustomerDataRequest(
      { customer: { id: '8886487220521' }, orders_requested: ['7001'] },
      shopDomain,
      'delivery-2',
      'customers/data_request',
    );

    expect(ordersRepo.findShopifyCustomerOrders).toHaveBeenCalledWith(
      'org-1',
      'integration-1',
      {
        customerId: '8886487220521',
        email: undefined,
        phones: [],
        externalOrderIds: ['7001'],
      },
    );
  });
});

describe('buildShopifyCustomerKeys', () => {
  const phoneService = new PhoneService();

  it('tries the phone as sent and in E.164', () => {
    const keys = buildShopifyCustomerKeys(
      { phone: ' +966 50 123 4567 ' },
      undefined,
      phoneService,
    );
    expect(keys.phones).toEqual(['+966 50 123 4567', '+966501234567']);
  });

  it('keeps an unparseable phone as sent and drops blank order ids', () => {
    const keys = buildShopifyCustomerKeys(
      { id: 42, phone: '0501234567' },
      [' 9 ', '', 9],
      phoneService,
    );
    expect(keys).toEqual({
      customerId: '42',
      email: undefined,
      phones: ['0501234567'],
      externalOrderIds: ['9'],
    });
  });
});
