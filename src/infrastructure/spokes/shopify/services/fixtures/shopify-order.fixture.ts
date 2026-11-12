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
  {
    name: 'manual and unpaid (COD order form)',
    payload: { payment_gateway_names: ['manual'], financial_status: 'pending' },
    eligible: true,
    reason: 'manual_unpaid_cod',
  },
  {
    name: 'manual with padding and case, unpaid',
    payload: {
      payment_gateway_names: [' Manual '],
      gateway: 'MANUAL',
      financial_status: ' Pending ',
    },
    eligible: true,
    reason: 'manual_unpaid_cod',
  },
  {
    name: 'manual on the gateway fallback, unpaid',
    payload: {
      payment_gateway_names: [],
      gateway: 'manual',
      financial_status: 'pending',
    },
    eligible: true,
    reason: 'manual_unpaid_cod',
  },
  {
    name: 'manual and paid',
    payload: { payment_gateway_names: ['manual'], financial_status: 'paid' },
    eligible: false,
    reason: 'non_cod_payment_method',
  },
  {
    name: 'manual without a financial status',
    payload: { payment_gateway_names: ['manual'] },
    eligible: false,
    reason: 'non_cod_payment_method',
  },
  {
    name: 'manual and authorized',
    payload: {
      payment_gateway_names: ['manual'],
      financial_status: 'authorized',
    },
    eligible: false,
    reason: 'non_cod_payment_method',
  },
  {
    name: 'manual and partially paid',
    payload: {
      payment_gateway_names: ['manual'],
      financial_status: 'partially_paid',
    },
    eligible: false,
    reason: 'non_cod_payment_method',
  },
  {
    name: 'manual next to another gateway, unpaid',
    payload: {
      payment_gateway_names: ['manual', 'shopify_payments'],
      financial_status: 'pending',
    },
    eligible: false,
    reason: 'non_cod_payment_method',
  },
  {
    name: 'manual list with a different fallback gateway, unpaid',
    payload: {
      payment_gateway_names: ['manual'],
      gateway: 'shopify_payments',
      financial_status: 'pending',
    },
    eligible: false,
    reason: 'non_cod_payment_method',
  },
  {
    name: 'named manual method, unpaid',
    payload: {
      payment_gateway_names: ['Bank Deposit'],
      financial_status: 'pending',
    },
    eligible: false,
    reason: 'non_cod_payment_method',
  },
  {
    name: 'non-string financial status',
    payload: { payment_gateway_names: ['manual'], financial_status: 1 },
    eligible: false,
    reason: 'non_cod_payment_method',
  },
] satisfies Array<{
  name: string;
  payload: Record<string, unknown>;
  eligible: boolean;
  reason?: string;
}>;
