import {
  buildChangeRequestEmail,
  changeRequestDashboardLink,
} from './change-request-email';
import { USAGE_ALERT_LANGUAGES } from './usage-alert-copy';

const id = '86cf9da1-71a0-4604-aa90-9da9329ed087';
describe('merchant request email and authenticated navigation', () => {
  it.each(USAGE_ALERT_LANGUAGES)(
    'renders escaped localized copy for %s',
    (language) => {
      const message = buildChangeRequestEmail(language, {
        store: '<script>Store</script>',
        order: '123',
        source: 'standalone',
        openedAt: '2026-11-09T10:00:00Z',
        timezone: 'Africa/Cairo',
        link: `https://app.example.test/${language}/verifications?open=${id}`,
      });
      expect(message.html).toContain('&lt;script&gt;');
      expect(message.html).not.toContain('<script>');
      expect(message.text).toContain('123');
      expect(message.text).toContain('standalone');
      expect(message.html).toContain(
        `dir="${['ar', 'ur'].includes(language) ? 'rtl' : 'ltr'}"`,
      );
    },
  );
  it('links to the protected order route without a token or public order data', () => {
    expect(
      changeRequestDashboardLink({
        language: 'en',
        verificationId: id,
        platformType: 'standalone',
        platformStoreUrl: '',
        dashboardUrl: 'https://app.example.test/ar/dashboard?old=1#old',
      }),
    ).toBe(`https://app.example.test/en/verifications?open=${id}`);
  });
  it('enters Shopify through authenticated Admin app navigation', () => {
    expect(
      changeRequestDashboardLink({
        language: 'ar',
        verificationId: id,
        platformType: 'shopify',
        platformStoreUrl: 'synthetic.myshopify.com',
        dashboardUrl: null,
        shopifyApiKey: 'synthetic-app',
      }),
    ).toBe(
      `https://synthetic.myshopify.com/admin/apps/synthetic-app/ar/verifications?open=${id}`,
    );
  });
  it.each([
    'javascript:alert(1)',
    'https://user:password@example.test',
    'http://untrusted.example.test',
  ])('rejects unsafe configured dashboard URL %s', (dashboardUrl) => {
    expect(
      changeRequestDashboardLink({
        language: 'en',
        verificationId: id,
        platformType: 'standalone',
        platformStoreUrl: '',
        dashboardUrl,
      }),
    ).toBeNull();
  });
});
