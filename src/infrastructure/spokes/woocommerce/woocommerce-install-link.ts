import {
  WOOCOMMERCE_INSTALL_CALLBACK_PATH,
  WOOCOMMERCE_WEBHOOK_PATH,
} from '../../../shared/config/woocommerce.config';

/** The store's own page that asks the merchant to authorize an app. */
export const WOOCOMMERCE_AUTHORIZE_PATH = '/wc-auth/v1/authorize';

export const WOOCOMMERCE_APP_NAME = 'Akeed';

/**
 * The least that works: Akeed reads orders and webhooks, and it creates
 * webhooks and updates orders (contract record finding 1.3).
 */
export const WOOCOMMERCE_SCOPE = 'read_write';

export const WOOCOMMERCE_INSTALL_LOCALES = ['ar', 'en'] as const;
export type WooCommerceInstallLocale =
  (typeof WOOCOMMERCE_INSTALL_LOCALES)[number];

export interface WooCommerceAuthorizeLinkInput {
  /** Canonical store URL. */
  storeUrl: string;
  publicApiBaseUrl: string;
  appBaseUrl: string;
  callbackToken: string;
  installReference: string;
  locale: WooCommerceInstallLocale;
}

export function buildWooCommerceCallbackUrl(
  publicApiBaseUrl: string,
  callbackToken: string,
): string {
  return `${publicApiBaseUrl}${WOOCOMMERCE_INSTALL_CALLBACK_PATH}/${callbackToken}`;
}

/** What every delivery URL Akeed registers starts with, in any install. */
export function buildWooCommerceWebhookDeliveryBase(
  publicApiBaseUrl: string,
): string {
  return `${publicApiBaseUrl}${WOOCOMMERCE_WEBHOOK_PATH}/`;
}

export function buildWooCommerceWebhookDeliveryUrl(
  publicApiBaseUrl: string,
  webhookToken: string,
): string {
  return `${buildWooCommerceWebhookDeliveryBase(publicApiBaseUrl)}${webhookToken}`;
}

/**
 * The authorize link has no `state`, so the callback token rides in the path
 * of Akeed's own callback URL (path, not query: query strings are logged
 * more widely) and the install reference is sent as `user_id`. The link is a
 * credential and is handed only to the owner or admin who started the
 * install. It never carries the webhook URL token.
 */
export function buildWooCommerceAuthorizeLink(
  input: WooCommerceAuthorizeLinkInput,
): string {
  const params: [string, string][] = [
    ['app_name', WOOCOMMERCE_APP_NAME],
    ['scope', WOOCOMMERCE_SCOPE],
    ['user_id', input.installReference],
    // A hint for the screen only; the callback is the proof.
    ['return_url', `${input.appBaseUrl}/${input.locale}/onboarding`],
    [
      'callback_url',
      buildWooCommerceCallbackUrl(input.publicApiBaseUrl, input.callbackToken),
    ],
  ];
  return `${input.storeUrl}${WOOCOMMERCE_AUTHORIZE_PATH}?${params
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&')}`;
}
