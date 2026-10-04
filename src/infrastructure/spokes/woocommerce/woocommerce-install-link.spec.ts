import {
  buildWooCommerceAuthorizeLink,
  buildWooCommerceCallbackUrl,
  buildWooCommerceWebhookDeliveryBase,
  buildWooCommerceWebhookDeliveryUrl,
} from './woocommerce-install-link';

const input = {
  storeUrl: 'https://example.com/shop',
  publicApiBaseUrl: 'https://api.akeed.test',
  appBaseUrl: 'https://app.akeed.test',
  callbackToken: 'C'.repeat(43),
  installReference: '482910573629104',
  locale: 'ar' as const,
};

describe('buildWooCommerceAuthorizeLink', () => {
  it("points at the store's own authorize page with the five documented parameters", () => {
    const link = buildWooCommerceAuthorizeLink(input);
    const url = new URL(link);

    expect(
      link.startsWith('https://example.com/shop/wc-auth/v1/authorize?'),
    ).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app_name: 'Akeed',
      scope: 'read_write',
      user_id: '482910573629104',
      return_url: 'https://app.akeed.test/ar/onboarding',
      callback_url: `https://api.akeed.test/api/woocommerce/install/callback/${'C'.repeat(43)}`,
    });
  });

  it('encodes every query value', () => {
    const query = buildWooCommerceAuthorizeLink(input).split('?')[1];

    expect(query).toContain(
      'return_url=https%3A%2F%2Fapp.akeed.test%2Far%2Fonboarding',
    );
    expect(query).toContain(
      'callback_url=https%3A%2F%2Fapi.akeed.test%2Fapi%2Fwoocommerce%2Finstall%2Fcallback%2F',
    );
    expect(query).not.toContain('://');
  });

  it('sends the merchant back in the language they started in', () => {
    const url = new URL(
      buildWooCommerceAuthorizeLink({ ...input, locale: 'en' }),
    );

    expect(url.searchParams.get('return_url')).toBe(
      'https://app.akeed.test/en/onboarding',
    );
  });

  it('carries the callback token in a path and no webhook address', () => {
    const link = buildWooCommerceAuthorizeLink(input);

    expect(buildWooCommerceCallbackUrl(input.publicApiBaseUrl, 'tok')).toBe(
      'https://api.akeed.test/api/woocommerce/install/callback/tok',
    );
    expect(decodeURIComponent(link)).not.toContain('/webhooks');
  });
});

describe('delivery URL', () => {
  it('puts the token in the path, under one base every install shares', () => {
    const base = buildWooCommerceWebhookDeliveryBase('https://api.akeed.test');

    expect(base).toBe('https://api.akeed.test/api/woocommerce/webhooks/');
    expect(
      buildWooCommerceWebhookDeliveryUrl('https://api.akeed.test', 'tok'),
    ).toBe(`${base}tok`);
  });
});
