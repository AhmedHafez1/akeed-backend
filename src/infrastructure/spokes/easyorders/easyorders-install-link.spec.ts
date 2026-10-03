import {
  buildEasyOrdersInstallLink,
  EASYORDERS_INSTALL_PERMISSIONS,
} from './easyorders-install-link';
import {
  generateInstallToken,
  hashInstallToken,
  installTokenHint,
  isWellFormedInstallToken,
} from './easyorders-install-token';

describe('EasyOrders install tokens', () => {
  it('generates 256-bit base64url tokens that never repeat', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateInstallToken()),
    );

    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(isWellFormedInstallToken(token)).toBe(true);
    }
  });

  it('hashes to SHA-256 hex, deterministically', () => {
    const token = generateInstallToken();

    expect(hashInstallToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInstallToken(token)).toBe(hashInstallToken(token));
    expect(hashInstallToken(token)).not.toBe(
      hashInstallToken(generateInstallToken()),
    );
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'short',
    'a'.repeat(44),
    `${'a'.repeat(42)}/`,
    `${'a'.repeat(42)}=`,
  ])('rejects %p as a token', (value) => {
    expect(isWellFormedInstallToken(value)).toBe(false);
  });

  it('keeps only the last six characters as the hint', () => {
    const token = generateInstallToken();

    expect(installTokenHint(token)).toBe(token.slice(-6));
  });
});

describe('EasyOrders install link', () => {
  const callbackToken = generateInstallToken();
  const webhookToken = generateInstallToken();
  const link = buildEasyOrdersInstallLink({
    publicApiBaseUrl: 'https://api.akeed.test',
    appBaseUrl: 'https://app.akeed.test',
    callbackToken,
    webhookToken,
    locale: 'ar',
  });
  const params = new URLSearchParams(link.split('?')[1]);

  it('targets the EasyOrders authorized-app page with every documented parameter', () => {
    expect(link.startsWith('https://app.easy-orders.net/#/install-app?')).toBe(
      true,
    );
    expect([...params.keys()]).toEqual([
      'app_name',
      'app_description',
      'app_icon',
      'permissions',
      'callback_url',
      'orders_webhook',
      'order_status_webhook',
      'redirect_url',
    ]);
  });

  it('asks for the minimum permissions only', () => {
    expect(EASYORDERS_INSTALL_PERMISSIONS).toEqual([
      'orders:read',
      'orders:update',
    ]);
    expect(params.get('permissions')).toBe('orders:read,orders:update');
  });

  it('carries each token in a URL path, never in a query string', () => {
    expect(params.get('callback_url')).toBe(
      `https://api.akeed.test/api/easyorders/install/callback/${callbackToken}`,
    );
    expect(params.get('orders_webhook')).toBe(
      `https://api.akeed.test/webhooks/easyorders/orders/${webhookToken}`,
    );
    expect(params.get('order_status_webhook')).toBe(
      `https://api.akeed.test/webhooks/easyorders/status/${webhookToken}`,
    );
    for (const name of [
      'callback_url',
      'orders_webhook',
      'order_status_webhook',
      'redirect_url',
    ]) {
      expect(new URL(params.get(name)!).search).toBe('');
    }
  });

  it('never puts the callback token in a webhook URL or the reverse', () => {
    expect(params.get('orders_webhook')).not.toContain(callbackToken);
    expect(params.get('order_status_webhook')).not.toContain(callbackToken);
    expect(params.get('callback_url')).not.toContain(webhookToken);
    expect(params.get('redirect_url')).toBe(
      'https://app.akeed.test/ar/onboarding',
    );
  });
});
