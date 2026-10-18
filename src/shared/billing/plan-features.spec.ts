import { includesLogoHeader } from './plan-features';

describe('includesLogoHeader', () => {
  it.each([
    ['starter', false],
    ['basic', false],
    ['pro', true],
    ['business', true],
    [null, false],
  ])('a Shopify store on %s: %s', (billingPlanId, expected) => {
    expect(includesLogoHeader({ platformType: 'shopify', billingPlanId })).toBe(
      expected,
    );
  });

  it.each(['standalone', 'easyorders', 'woocommerce'])(
    'a prepaid-credit %s store always includes it',
    (platformType) => {
      expect(
        includesLogoHeader({ platformType, billingPlanId: 'starter' }),
      ).toBe(true);
      expect(includesLogoHeader({ platformType, billingPlanId: null })).toBe(
        true,
      );
    },
  );

  it('an unknown plan does not include it', () => {
    expect(
      includesLogoHeader({ platformType: 'shopify', billingPlanId: 'gold' }),
    ).toBe(false);
  });
});
