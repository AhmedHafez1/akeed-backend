import { ValidationPipe } from '@nestjs/common';
import { ShopifyOrderWebhookDto } from './shopify-webhooks.dto';

/**
 * The global pipe in `main.ts` runs before the controller's own and strips
 * what a DTO does not declare, so an order keeps only the fields named here.
 */
const globalPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: false,
});

function throughGlobalPipe(body: Record<string, unknown>) {
  return globalPipe.transform(body, {
    type: 'body',
    metatype: ShopifyOrderWebhookDto,
  }) as Promise<Record<string, unknown>>;
}

const ORDER = { id: 12345, order_number: 1001, total_price: '360.00' };

describe('ShopifyOrderWebhookDto under the global pipe', () => {
  it('keeps the delivery address and a projection of the order lines', async () => {
    const order = await throughGlobalPipe({
      ...ORDER,
      shipping_address: {
        phone: '+201001234567',
        country_code: 'EG',
        address1: '12 Nile Street',
        address2: 'Floor 3',
        city: 'Maadi',
        province: 'Cairo',
        zip: '11728',
        latitude: 29.96,
      },
      line_items: [
        {
          id: 1,
          title: 'Lunch box',
          name: 'Lunch box - Blue',
          variant_title: 'Blue',
          quantity: 2,
          price: '180.00',
          sku: 'LB-BLUE',
          properties: [{ name: 'gift', value: 'yes' }],
        },
      ],
    });

    expect(order.shipping_address).toEqual({
      phone: '+201001234567',
      country_code: 'EG',
      address1: '12 Nile Street',
      address2: 'Floor 3',
      city: 'Maadi',
      province: 'Cairo',
    });
    expect(order.line_items).toEqual([
      {
        title: 'Lunch box',
        name: 'Lunch box - Blue',
        variant_title: 'Blue',
        quantity: 2,
        price: '180.00',
      },
    ]);
  });

  it('keeps the street out of the billing and customer addresses', async () => {
    const order = await throughGlobalPipe({
      ...ORDER,
      billing_address: { phone: '+201001234567', address1: '9 Other Street' },
      customer: { default_address: { city: 'Giza', country_code: 'EG' } },
    });

    expect(order.billing_address).toEqual({ phone: '+201001234567' });
    expect(order.customer).toEqual({ default_address: { country_code: 'EG' } });
  });

  it('never refuses an order for the shape of its lines or address', async () => {
    const order = await throughGlobalPipe({
      ...ORDER,
      shipping_address: { address1: null, city: 42, province: ['Cairo'] },
      line_items: 'not a list',
    });

    expect(order.shipping_address).toEqual({});
    expect(order.line_items).toBeUndefined();

    await expect(
      throughGlobalPipe({ ...ORDER, line_items: [null, 'x', { title: 7 }] }),
    ).resolves.toMatchObject({
      line_items: [{ title: 7 }],
    });
  });
});
