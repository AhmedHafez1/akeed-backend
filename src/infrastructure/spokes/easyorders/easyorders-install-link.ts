import { EASYORDERS_INSTALL_CALLBACK_PATH } from '../../../shared/config/easyorders.config';

/** The EasyOrders dashboard page that asks the seller to authorize an app. */
export const EASYORDERS_INSTALL_PAGE =
  'https://app.easy-orders.net/#/install-app';

/**
 * The least Akeed needs: read new orders, and update an order's status when
 * the customer confirms or cancels. Nothing else is requested.
 */
export const EASYORDERS_INSTALL_PERMISSIONS = ['orders:read', 'orders:update'];

export const EASYORDERS_APP_NAME = 'Akeed';
export const EASYORDERS_APP_DESCRIPTION =
  'COD order confirmation over WhatsApp';

export const EASYORDERS_INSTALL_LOCALES = ['ar', 'en'] as const;
export type EasyOrdersInstallLocale =
  (typeof EASYORDERS_INSTALL_LOCALES)[number];

export interface EasyOrdersInstallLinkInput {
  publicApiBaseUrl: string;
  appBaseUrl: string;
  callbackToken: string;
  webhookToken: string;
  locale: EasyOrdersInstallLocale;
}

export function buildEasyOrdersWebhookUrl(
  publicApiBaseUrl: string,
  kind: 'orders' | 'status',
  webhookToken: string,
): string {
  return `${publicApiBaseUrl}/webhooks/easyorders/${kind}/${webhookToken}`;
}

/**
 * EasyOrders has no `state` parameter, so both tokens ride in the path of
 * Akeed's own URLs (path, not query: query strings are logged more widely).
 * The link is a credential and is handed only to the owner or admin who
 * started the install.
 */
export function buildEasyOrdersInstallLink(
  input: EasyOrdersInstallLinkInput,
): string {
  const params: [string, string][] = [
    ['app_name', EASYORDERS_APP_NAME],
    ['app_description', EASYORDERS_APP_DESCRIPTION],
    ['app_icon', `${input.appBaseUrl}/favicon.ico`],
    ['permissions', EASYORDERS_INSTALL_PERMISSIONS.join(',')],
    [
      'callback_url',
      `${input.publicApiBaseUrl}${EASYORDERS_INSTALL_CALLBACK_PATH}/${input.callbackToken}`,
    ],
    [
      'orders_webhook',
      buildEasyOrdersWebhookUrl(
        input.publicApiBaseUrl,
        'orders',
        input.webhookToken,
      ),
    ],
    [
      'order_status_webhook',
      buildEasyOrdersWebhookUrl(
        input.publicApiBaseUrl,
        'status',
        input.webhookToken,
      ),
    ],
    ['redirect_url', `${input.appBaseUrl}/${input.locale}/onboarding`],
  ];
  return `${EASYORDERS_INSTALL_PAGE}?${params
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&')}`;
}
