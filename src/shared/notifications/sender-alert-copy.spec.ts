import {
  buildSenderAlertEmail,
  SENDER_ALERT_COPY,
  WHATSAPP_MANAGER_URL,
} from './sender-alert-copy';
import { USAGE_ALERT_LANGUAGES, usageAlertLanguage } from './usage-alert-copy';
import { SENDER_ALERT_KINDS, type SenderAlert } from './sender-alert.policy';

describe('sender alert copy', () => {
  it.each(USAGE_ALERT_LANGUAGES)(
    '%s has identical keys and translated copy for every kind',
    (language) => {
      expect(Object.keys(SENDER_ALERT_COPY[language]).sort()).toEqual(
        Object.keys(SENDER_ALERT_COPY.en).sort(),
      );
      for (const kind of SENDER_ALERT_KINDS) {
        const alert: SenderAlert = {
          kind,
          reason: 'payment',
          action: 'whatsapp_manager',
          severity: 'warning',
          templates: [],
        };
        const email = buildSenderAlertEmail(
          language,
          alert,
          'https://example.test/dashboard?one=1&two=2',
        );
        expect(email.subject.length).toBeGreaterThan(5);
        expect(email.text).toContain(WHATSAPP_MANAGER_URL);
        expect(email.html).toContain(
          `dir="${['ar', 'ur'].includes(language) ? 'rtl' : 'ltr'}"`,
        );
        expect(email.html).toContain('&amp;two=2');
        if (language !== 'en')
          expect(email.subject).not.toEqual(
            buildSenderAlertEmail('en', alert, null).subject,
          );
      }
    },
  );
  it('has specific inactivity, credential and restriction instructions', () => {
    for (const reason of [
      'primary_inactivity',
      'credentials',
      'restricted',
    ] as const) {
      const email = buildSenderAlertEmail(
        'en',
        {
          kind: 'disconnect',
          reason,
          action: 'reconnect',
          severity: 'critical',
          templates: [],
        },
        null,
      );
      expect(email.text).toContain(SENDER_ALERT_COPY.en[reason]);
    }
    expect(SENDER_ALERT_COPY.en.primary_inactivity).toContain('two weeks');
  });
  it('rejects unsafe dashboard links and never renders template data', () => {
    const alert: SenderAlert = {
      kind: 'template_rejection',
      reason: 'unavailable',
      action: 'review_templates',
      severity: 'warning',
      templates: [
        {
          key: '<script>secret</script>',
          language: 'en',
          status: 'rejected',
          category: 'utility',
        },
      ],
    };
    const result = buildSenderAlertEmail('en', alert, 'javascript:alert(1)');
    expect(JSON.stringify(result)).not.toMatch(/secret|javascript|<script>/);
    expect(usageAlertLanguage('auto')).toBe('ar');
  });
});
