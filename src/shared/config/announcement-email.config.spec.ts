import { parseAnnouncementEmailConfig } from './announcement-email.config';
describe('announcement email configuration', () => {
  it('defaults off with the approved pace', () =>
    expect(parseAnnouncementEmailConfig({})).toMatchObject({
      enabled: false,
      batchSize: 50,
      intervalMs: 300000,
    }));
  it.each([
    { ANNOUNCEMENT_EMAIL_ENABLED: 'yes' },
    { ANNOUNCEMENT_EMAIL_BATCH_SIZE: '0' },
    { ANNOUNCEMENT_EMAIL_INTERVAL_MS: '1' },
    { ANNOUNCEMENT_EMAIL_PUBLIC_API_URL: 'http://localhost' },
    { ANNOUNCEMENT_EMAIL_ENABLED: 'true' },
  ])('rejects unsafe configuration %p', (value) =>
    expect(() => parseAnnouncementEmailConfig(value)).toThrow(),
  );
  it('requires sending dependencies without exposing their values in errors', () => {
    const env = {
      ANNOUNCEMENT_EMAIL_ENABLED: 'true',
      EMAIL_ALERTS_ENABLED: 'true',
      RESEND_API_KEY: 'synthetic-key',
      EMAIL_FROM: 'Akeed <hello@example.test>',
      FRONTEND_DASHBOARD_URL: 'https://getakeed.com',
      ANNOUNCEMENT_EMAIL_PUBLIC_API_URL: 'https://api.getakeed.com',
      ANNOUNCEMENT_EMAIL_UNSUBSCRIBE_SECRET:
        'synthetic-signing-secret-at-least-32-characters',
    };
    expect(parseAnnouncementEmailConfig(env).enabled).toBe(true);
    expect(() =>
      parseAnnouncementEmailConfig({
        ...env,
        ANNOUNCEMENT_EMAIL_PUBLIC_API_URL: 'https://user:password@example.test',
      }),
    ).toThrow('ANNOUNCEMENT_EMAIL_PUBLIC_API_URL');
  });
});
