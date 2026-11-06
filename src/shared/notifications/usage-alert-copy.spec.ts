import {
  buildUsageAlertEmail,
  USAGE_ALERT_LANGUAGES,
  type UsageAlertFacts,
} from './usage-alert-copy';

const base: UsageAlertFacts = {
  level: '80',
  storeName: 'Nile Goods',
  used: 320,
  limit: 400,
  blockedCount: 0,
  action: 'upgrade',
  resetDate: '2026-12-04',
  dashboardUrl: 'https://app.example.test/dashboard',
};

const pools = {
  akeed: { used: 90, limit: 100, remaining: 10 },
  ownNumber: { used: 230, limit: 300, remaining: 70 },
};

describe('buildUsageAlertEmail pools', () => {
  it.each(USAGE_ALERT_LANGUAGES)(
    'reports each pool instead of the combined figures in %s',
    (language) => {
      const plain = buildUsageAlertEmail(language, base);
      const split = buildUsageAlertEmail(language, { ...base, pools });
      for (const figure of ['90', '100', '230', '300'])
        expect(split.text).toContain(figure);
      expect(split.text).not.toContain('320');
      expect(split.text).toContain('Meta');
      expect(split.subject).toBe(plain.subject);
      expect(split.html).toContain(
        `dir="${language === 'ar' || language === 'ur' ? 'rtl' : 'ltr'}"`,
      );
    },
  );

  it('keeps the original email when no pools are reported', () => {
    const email = buildUsageAlertEmail('en', { ...base, pools: null });
    expect(email.text).toContain(
      'You have used 320 of 400 WhatsApp confirmations in this period.',
    );
    expect(email.text).not.toContain('Meta');
  });
});
