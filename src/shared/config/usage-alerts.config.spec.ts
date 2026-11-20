import {
  parseUsageAlertsConfig,
  readUsageAlertsConfig,
} from './usage-alerts.config';

describe('parseUsageAlertsConfig', () => {
  it('defaults to email off, recovery on and a 24-hour limit', () => {
    expect(parseUsageAlertsConfig({})).toEqual({
      emailEnabled: false,
      resendApiKey: null,
      emailFrom: null,
      dashboardUrl: null,
      recoveryEnabled: true,
      blockedOrderMaxAgeHours: 24,
    });
  });

  it('reads every setting', () => {
    expect(
      parseUsageAlertsConfig({
        EMAIL_ALERTS_ENABLED: 'true',
        RESEND_API_KEY: ' re_test ',
        EMAIL_FROM: 'Akeed <alerts@example.test>',
        FRONTEND_DASHBOARD_URL: 'https://app.example.test/dashboard',
        BLOCKED_ORDER_RECOVERY_ENABLED: 'false',
        BLOCKED_ORDER_MAX_AGE_HOURS: '48',
      }),
    ).toEqual({
      emailEnabled: true,
      resendApiKey: 're_test',
      emailFrom: 'Akeed <alerts@example.test>',
      dashboardUrl: 'https://app.example.test/dashboard',
      recoveryEnabled: false,
      blockedOrderMaxAgeHours: 48,
    });
  });

  it('refuses email alerts without a key and a sender', () => {
    expect(() =>
      parseUsageAlertsConfig({ EMAIL_ALERTS_ENABLED: 'true' }),
    ).toThrow('EMAIL_ALERTS_ENABLED=true needs RESEND_API_KEY and EMAIL_FROM');
    expect(() =>
      parseUsageAlertsConfig({
        EMAIL_ALERTS_ENABLED: 'true',
        RESEND_API_KEY: 're_test',
      }),
    ).toThrow('EMAIL_FROM');
  });

  it.each(['0', '721', '1.5', 'soon'])(
    'refuses a blocked-order age of %s',
    (value) => {
      expect(() =>
        parseUsageAlertsConfig({ BLOCKED_ORDER_MAX_AGE_HOURS: value }),
      ).toThrow('BLOCKED_ORDER_MAX_AGE_HOURS');
    },
  );

  it('refuses a switch that is not true or false', () => {
    expect(() =>
      parseUsageAlertsConfig({ BLOCKED_ORDER_RECOVERY_ENABLED: 'yes' }),
    ).toThrow('BLOCKED_ORDER_RECOVERY_ENABLED must be true or false');
  });

  it('falls back to the defaults when the config was not registered', () => {
    expect(readUsageAlertsConfig({ get: () => undefined })).toEqual(
      parseUsageAlertsConfig({}),
    );
  });
});
