export function shopifyOrderFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 12345,
    order_number: 1001,
    phone: '+201001234567',
    customer: { first_name: 'Synthetic', last_name: 'Customer' },
    total_price: '123.40',
    currency: 'EGP',
    payment_gateway_names: ['Cash on Delivery (COD)'],
    ...overrides,
  };
}

export const shopifyPaymentFixtures = [
  {
    name: 'gateway list',
    payload: { payment_gateway_names: ['cod'] },
    eligible: true,
  },
  {
    name: 'gateway fallback',
    payload: { payment_gateway_names: [], gateway: 'cash_on_delivery' },
    eligible: true,
  },
  {
    name: 'transaction gateway',
    payload: {
      payment_gateway_names: [],
      transactions: [{ gateway: 'pay-on-delivery' }],
    },
    eligible: true,
  },
  {
    name: 'Arabic payment',
    payload: { payment_gateway_names: ['الدفع عند الاستلام'] },
    eligible: true,
  },
  {
    name: 'Arabic cash',
    payload: { payment_gateway_names: [], gateway: 'كاش عند الاستلام' },
    eligible: true,
  },
  {
    name: 'prepaid',
    payload: { payment_gateway_names: ['shopify_payments'] },
    eligible: false,
  },
  {
    name: 'missing signals',
    payload: { payment_gateway_names: [] },
    eligible: false,
  },
  {
    name: 'malformed transaction entries',
    payload: {
      payment_gateway_names: [],
      transactions: [null, 42, [], {}, { gateway: 3 }, { gateway: 'COD' }],
    },
    eligible: true,
  },
] satisfies Array<{
  name: string;
  payload: Record<string, unknown>;
  eligible: boolean;
}>;
