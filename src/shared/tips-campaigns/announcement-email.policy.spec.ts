import {
  announcementIssues,
  announcementPlanLine,
  renderAnnouncement,
  type AnnouncementEmail,
} from './announcement-email.policy';
import { INTERFACE_LOCALES } from '../i18n/interface-locales';
import { resolveOwnNumberIncludedVerifications } from '../billing/billing-plan';

const email: AnnouncementEmail = {
  translations: [
    {
      locale: 'en',
      subject: 'Your own number',
      body: 'Hi {storeName}\n{planLine}\n{dashboardLink}\n{guideLink}',
    },
  ],
};
describe('announcement personalization', () => {
  it('rejects unknown/malformed placeholders at review, while allowing draft correction', () => {
    for (const body of ['{recipient}', '{storeName', '{{storeName}}']) {
      const draft = {
        translations: [{ locale: 'en', subject: 'Launch', body }],
      };
      expect(announcementIssues(draft)).toEqual([]);
      expect(announcementIssues(draft, true)).not.toEqual([]);
    }
  });
  it('rejects header injection, missing English, duplicate languages and invalid payloads', () => {
    for (const value of [
      {
        translations: [{ locale: 'en', subject: 'x\r\nBcc: y', body: 'Hello' }],
      },
      { translations: [] },
      { translations: [...email.translations, ...email.translations] },
      { translations: [null] },
    ])
      expect(announcementIssues(value, true).length).toBeGreaterThan(0);
  });
  it.each(INTERFACE_LOCALES)(
    'builds all five billing samples with Western digits in %s',
    (locale) => {
      for (const plan of ['starter', 'basic', 'pro', 'business'] as const) {
        const line = announcementPlanLine(
          locale,
          { platformType: 'shopify', billingPlanId: plan },
          200,
        );
        expect(line).not.toBeNull();
        const numbers = line!.replace(/[^0-9]/g, '');
        expect(numbers).toContain(
          String(resolveOwnNumberIncludedVerifications(plan)),
        );
        expect(line).not.toMatch(/[٠-٩۰-۹]/);
      }
      expect(
        announcementPlanLine(
          locale,
          { platformType: 'woocommerce', billingPlanId: null },
          200,
        ),
      ).toMatch(/1/);
    },
  );
  it('uses Latin American Spanish number formatting for allowance and credit price', () => {
    expect(
      announcementPlanLine(
        'es',
        { platformType: 'shopify', billingPlanId: 'business' },
        200,
      ),
    ).toContain('20,000');
    expect(
      announcementPlanLine(
        'es',
        { platformType: 'standalone', billingPlanId: null },
        300,
      ),
    ).toContain('1.5 EGP');
  });
  it('uses configured prepaid pricing and rejects unsupported Shopify plans', () => {
    expect(
      announcementPlanLine(
        'en',
        { platformType: 'easyorders', billingPlanId: 'starter' },
        600,
      ),
    ).toContain('3 EGP');
    expect(
      announcementPlanLine(
        'en',
        { platformType: 'shopify', billingPlanId: 'unknown' },
        200,
      ),
    ).toBeNull();
    expect(
      announcementPlanLine(
        'en',
        { platformType: 'shopify', billingPlanId: 'starter' },
        200,
      ),
    ).toContain('one-time');
  });
  it('escapes merchant text, fills all values and keeps unknown merchant values out of markup', () => {
    const result = renderAnnouncement(
      email,
      'en',
      {
        storeName: '<img src=x onerror=alert(1)>',
        planLine: '90 one-time',
        dashboardLink: 'https://getakeed.com/en/settings?tab=whatsapp',
        guideLink: 'https://getakeed.com/en/docs/own-whatsapp-number',
      },
      'https://api.example.test/unsubscribe?t=x',
    );
    expect(result).toHaveProperty('html');
    if ('html' in result) {
      expect(result.html).not.toContain('<img');
      expect(result.html).toContain('&lt;img');
      expect(result.text).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });
  it('skips only when a placeholder actually used by the body lacks a value', () => {
    expect(
      renderAnnouncement(
        email,
        'en',
        {
          storeName: null,
          planLine: null,
          dashboardLink: null,
          guideLink: null,
        },
        'https://api.example.test/u',
      ),
    ).toEqual({ missing: 'guideLink' });
    expect(
      renderAnnouncement(
        { translations: [{ locale: 'en', subject: 'Hello', body: 'News' }] },
        'ar',
        {
          storeName: null,
          planLine: null,
          dashboardLink: null,
          guideLink: null,
        },
        'https://api.example.test/u',
      ),
    ).toHaveProperty('text');
  });
  it.each(['ar', 'ur'] as const)('renders %s email as RTL', (locale) => {
    const result = renderAnnouncement(
      {
        translations: [
          { locale, subject: 'خبر', body: 'مرحبًا' },
          ...email.translations,
        ],
      },
      locale,
      { storeName: null, planLine: null, dashboardLink: null, guideLink: null },
      'https://api.example.test/u',
    );
    if ('html' in result) expect(result.html).toContain('dir="rtl"');
    else throw new Error('Missing preview');
  });
});
