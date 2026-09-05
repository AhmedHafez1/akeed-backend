import { StandaloneManualOrderNormalizer } from './standalone-manual-order.normalizer';

describe('StandaloneManualOrderNormalizer', () => {
  const normalizer = new StandaloneManualOrderNormalizer();
  const payload = {
    ingestionType: 'manual',
    schemaVersion: 1,
    submissionFingerprint: 'fingerprint-1',
    order: {
      externalOrderId: 'manual-order-1',
      orderNumber: 'A-101',
      customerPhone: '+201001234567',
      customerName: 'Customer',
      totalPrice: '125.50',
      currency: 'EGP',
      paymentMethod: 'cash_on_delivery',
      paymentSignals: ['forged-signal'],
      codStatus: 'non_cod',
      orgId: 'forged-org',
      integrationId: 'forged-source',
    },
  };

  it('normalizes persisted schema v1 and derives trusted identity and payment signals', () => {
    expect(
      normalizer.normalizeOrder(payload, 'trusted-source', 'trusted-org'),
    ).toMatchObject({
      orgId: 'trusted-org',
      integrationId: 'trusted-source',
      externalOrderId: 'manual-order-1',
      orderNumber: 'A-101',
      customerPhone: '+201001234567',
      customerName: 'Customer',
      totalPrice: '125.50',
      currency: 'EGP',
      paymentMethod: 'cash_on_delivery',
      paymentSignals: ['cash on delivery'],
      codStatus: 'cod',
    });
  });

  it.each([
    [{ ...payload, ingestionType: 'shopify' }],
    [{ ...payload, schemaVersion: 2 }],
    [{ ...payload, submissionFingerprint: null }],
    [{ ...payload, order: null }],
    [{ ...payload, order: { ...payload.order, externalOrderId: '' } }],
    [{ ...payload, order: { ...payload.order, customerPhone: 123 } }],
    [{ ...payload, order: { ...payload.order, totalPrice: null } }],
    [{ ...payload, order: { ...payload.order, paymentMethod: 1 } }],
  ])('rejects a corrupt persisted envelope', (input) => {
    expect(
      normalizer.normalizeOrder(input as never, 'source-1', 'org-1'),
    ).toBeNull();
  });

  it.each([
    [undefined, 'unknown'],
    ['', 'unknown'],
    ['card', 'non_cod'],
  ])(
    'preserves a %p payment method as a %s eligibility signal',
    (paymentMethod, codStatus) => {
      const order = { ...payload.order, paymentMethod };
      const result = normalizer.normalizeOrder(
        { ...payload, order },
        'source-1',
        'org-1',
      );
      expect(result).toMatchObject({ codStatus });
    },
  );
});
