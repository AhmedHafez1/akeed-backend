import { whatsappSettingsLink } from './whatsapp-settings-link';

describe('WhatsApp settings return destination', () => {
  const input = {
    language: 'ar' as const,
    platformType: 'standalone',
    platformStoreUrl: '',
    dashboardUrl: 'https://app.example.test/en/dashboard?discard=1#fragment',
  };
  it('returns to the localized standalone WhatsApp tab with no carried parameters', () => {
    expect(whatsappSettingsLink(input)).toBe(
      'https://app.example.test/ar/settings?tab=whatsapp',
    );
  });
  it('returns through the trusted Shopify Admin app link', () => {
    expect(
      whatsappSettingsLink({
        ...input,
        language: 'fr',
        platformType: 'shopify',
        platformStoreUrl: 'synthetic.myshopify.com',
        shopifyApiKey: 'synthetic-app',
      }),
    ).toBe(
      'https://synthetic.myshopify.com/admin/apps/synthetic-app/fr/settings?tab=whatsapp',
    );
  });
  it.each([
    'evil.example.test',
    'synthetic.myshopify.com.evil.test',
    'synthetic.myshopify.com@evil.test',
    'synthetic.myshopify.com/path',
  ])('refuses untrusted Shopify identity %s', (platformStoreUrl) => {
    expect(
      whatsappSettingsLink({
        ...input,
        platformType: 'shopify',
        platformStoreUrl,
        shopifyApiKey: 'synthetic-app',
      }),
    ).toBeNull();
  });
  it.each([
    'javascript:alert(1)',
    'https://user:pass@example.test',
    'http://example.test',
  ])('refuses unsafe configured origins %s', (dashboardUrl) => {
    expect(whatsappSettingsLink({ ...input, dashboardUrl })).toBeNull();
  });
});
