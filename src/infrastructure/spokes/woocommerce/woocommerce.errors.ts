import { HttpException, HttpStatus } from '@nestjs/common';
import type { WooCommerceCallFailure } from './woocommerce-api.client';

/**
 * The codes the WooCommerce connection and delivery URL answer with (US-07-01
 * contract record, support boundary). The frontend translates by code, so these are
 * never renamed.
 */
export type WooCommerceErrorCode =
  | 'WOOCOMMERCE_CONNECT_UNAVAILABLE'
  | 'WOOCOMMERCE_PILOT_REQUIRED'
  | 'WOOCOMMERCE_SESSION_REQUIRED'
  | 'WOOCOMMERCE_SOURCE_EXISTS'
  | 'WOOCOMMERCE_INSTALL_VALIDATION_FAILED'
  | 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID'
  | 'WOOCOMMERCE_CALLBACK_INVALID'
  | 'WOOCOMMERCE_PROVIDER_UNAVAILABLE'
  | 'WOOCOMMERCE_STORE_URL_INVALID'
  | 'WOOCOMMERCE_STORE_HTTPS_REQUIRED'
  | 'WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC'
  | 'WOOCOMMERCE_STORE_REDIRECTS'
  | 'WOOCOMMERCE_STORE_TLS_FAILED'
  | 'WOOCOMMERCE_REST_NOT_FOUND'
  | 'WOOCOMMERCE_REST_UNREACHABLE'
  | 'WOOCOMMERCE_CREDENTIALS_REJECTED'
  | 'WOOCOMMERCE_PERMISSION_DENIED'
  | 'WOOCOMMERCE_STORE_URL_MISMATCH'
  | 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED'
  | 'WOOCOMMERCE_STORE_UNAVAILABLE'
  | 'WOOCOMMERCE_INGESTION_UNAVAILABLE'
  | 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED'
  | 'WOOCOMMERCE_NOT_CONNECTED'
  | 'WOOCOMMERCE_RECONNECT_STORE_MISMATCH'
  | 'WOOCOMMERCE_WEBHOOK_MISSING'
  | 'WOOCOMMERCE_WEBHOOK_DISABLED'
  | 'WOOCOMMERCE_WEBHOOK_PAUSED'
  | 'WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE'
  | 'WOOCOMMERCE_WEBHOOK_ENABLE_FAILED';

/** Used with `assertOrganizationWriteAllowed`; viewers are read-only. */
export const WOOCOMMERCE_ROLE_REQUIRED = {
  code: 'WOOCOMMERCE_ROLE_REQUIRED',
  message:
    'Owner or admin role is required to manage the WooCommerce connection',
} as const;

const STATUS: Record<WooCommerceErrorCode, HttpStatus> = {
  WOOCOMMERCE_CONNECT_UNAVAILABLE: HttpStatus.NOT_FOUND,
  WOOCOMMERCE_PILOT_REQUIRED: HttpStatus.FORBIDDEN,
  WOOCOMMERCE_SESSION_REQUIRED: HttpStatus.FORBIDDEN,
  WOOCOMMERCE_SOURCE_EXISTS: HttpStatus.CONFLICT,
  WOOCOMMERCE_INSTALL_VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  WOOCOMMERCE_INSTALL_CONTEXT_INVALID: HttpStatus.UNAUTHORIZED,
  WOOCOMMERCE_CALLBACK_INVALID: HttpStatus.BAD_REQUEST,
  WOOCOMMERCE_PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  WOOCOMMERCE_STORE_URL_INVALID: HttpStatus.BAD_REQUEST,
  WOOCOMMERCE_STORE_HTTPS_REQUIRED: HttpStatus.BAD_REQUEST,
  WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC: HttpStatus.UNPROCESSABLE_ENTITY,
  WOOCOMMERCE_STORE_REDIRECTS: HttpStatus.UNPROCESSABLE_ENTITY,
  WOOCOMMERCE_STORE_TLS_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  WOOCOMMERCE_REST_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  WOOCOMMERCE_REST_UNREACHABLE: HttpStatus.SERVICE_UNAVAILABLE,
  WOOCOMMERCE_CREDENTIALS_REJECTED: HttpStatus.UNPROCESSABLE_ENTITY,
  WOOCOMMERCE_PERMISSION_DENIED: HttpStatus.UNPROCESSABLE_ENTITY,
  WOOCOMMERCE_STORE_URL_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  WOOCOMMERCE_WEBHOOK_SETUP_FAILED: HttpStatus.SERVICE_UNAVAILABLE,
  WOOCOMMERCE_STORE_UNAVAILABLE: HttpStatus.CONFLICT,
  WOOCOMMERCE_INGESTION_UNAVAILABLE: HttpStatus.NOT_FOUND,
  WOOCOMMERCE_WEBHOOK_UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  WOOCOMMERCE_NOT_CONNECTED: HttpStatus.NOT_FOUND,
  WOOCOMMERCE_RECONNECT_STORE_MISMATCH: HttpStatus.CONFLICT,
  WOOCOMMERCE_WEBHOOK_MISSING: HttpStatus.CONFLICT,
  WOOCOMMERCE_WEBHOOK_DISABLED: HttpStatus.CONFLICT,
  WOOCOMMERCE_WEBHOOK_PAUSED: HttpStatus.CONFLICT,
  WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  WOOCOMMERCE_WEBHOOK_ENABLE_FAILED: HttpStatus.SERVICE_UNAVAILABLE,
};

const MESSAGES: Record<WooCommerceErrorCode, string> = {
  WOOCOMMERCE_CONNECT_UNAVAILABLE: 'WooCommerce connection is not available.',
  WOOCOMMERCE_PILOT_REQUIRED:
    'This organization is not approved for the WooCommerce pilot yet.',
  WOOCOMMERCE_SESSION_REQUIRED:
    'WooCommerce can only be connected from an Akeed account session.',
  WOOCOMMERCE_SOURCE_EXISTS:
    'This organization already has a commerce source and cannot connect another.',
  WOOCOMMERCE_INSTALL_VALIDATION_FAILED: 'The install request is invalid.',
  // One answer for an unknown, expired, used, replaced or busy install link:
  // it never says which.
  WOOCOMMERCE_INSTALL_CONTEXT_INVALID: 'This install link is not valid.',
  WOOCOMMERCE_CALLBACK_INVALID: 'The install callback is invalid.',
  WOOCOMMERCE_PROVIDER_UNAVAILABLE:
    'The store did not answer in time. Try again.',
  WOOCOMMERCE_STORE_URL_INVALID:
    "Enter your store's address, for example https://example.com.",
  WOOCOMMERCE_STORE_HTTPS_REQUIRED:
    "Your store's address must start with https://. Akeed does not connect to stores without HTTPS.",
  WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC:
    'Akeed could not reach this address on the public internet. Check the address and try again.',
  WOOCOMMERCE_STORE_REDIRECTS:
    "This address redirects to another one. Enter your store's final address, with or without www, exactly as it appears in the browser.",
  WOOCOMMERCE_STORE_TLS_FAILED:
    "Your store's security certificate is not valid. Ask your hosting provider to fix it, then try again.",
  WOOCOMMERCE_REST_NOT_FOUND:
    'Akeed could not find the WooCommerce REST API at this address. In WordPress, open Settings > Permalinks, choose any option other than Plain, and make sure WooCommerce is up to date.',
  WOOCOMMERCE_REST_UNREACHABLE:
    'Your store did not answer. It may be down, in maintenance mode or blocking outside requests. Try again later or ask your hosting provider.',
  WOOCOMMERCE_CREDENTIALS_REJECTED:
    'Your store did not accept the new API key. Some hosting setups remove the Authorization header before it reaches WordPress; ask your hosting provider to allow it. Then delete the unused key under WooCommerce > Settings > Advanced > REST API and connect again.',
  WOOCOMMERCE_PERMISSION_DENIED:
    'The WordPress user who approved the connection cannot manage WooCommerce. Sign in to your store as an administrator or shop manager and connect again.',
  WOOCOMMERCE_STORE_URL_MISMATCH:
    'Your store reports a different address from the one you entered. Enter the address exactly as it is set in WordPress, then connect again.',
  WOOCOMMERCE_WEBHOOK_SETUP_FAILED:
    'Akeed could not finish setting up order notifications in your store. Nothing was connected. Try again.',
  WOOCOMMERCE_STORE_UNAVAILABLE:
    'This store is already connected to another Akeed account.',
  WOOCOMMERCE_INGESTION_UNAVAILABLE: 'Not Found',
  // One answer for a wrong token, signature or source: it never says which.
  WOOCOMMERCE_WEBHOOK_UNAUTHORIZED: 'This delivery was not accepted.',
  WOOCOMMERCE_NOT_CONNECTED: 'WooCommerce is not connected to this account.',
  WOOCOMMERCE_RECONNECT_STORE_MISMATCH:
    'Only the store that was connected before can be reconnected. Nothing was changed.',
  WOOCOMMERCE_WEBHOOK_MISSING:
    'An Akeed order notification was deleted in the store. Disconnect, then connect the same store again.',
  WOOCOMMERCE_WEBHOOK_DISABLED:
    'The store disabled an Akeed order notification after failed deliveries.',
  WOOCOMMERCE_WEBHOOK_PAUSED:
    'An Akeed order notification is paused in the store.',
  WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE:
    'Order notifications cannot be re-enabled right now.',
  WOOCOMMERCE_WEBHOOK_ENABLE_FAILED:
    'The store did not re-enable the order notification.',
};

const ERROR_NAME: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};

/** The codes a failed store call maps to, whichever call it was. */
const STORE_FAILURE_CODES: Partial<
  Record<WooCommerceCallFailure, WooCommerceErrorCode>
> = {
  address_not_public: 'WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC',
  redirects: 'WOOCOMMERCE_STORE_REDIRECTS',
  tls_failed: 'WOOCOMMERCE_STORE_TLS_FAILED',
  credentials_rejected: 'WOOCOMMERCE_CREDENTIALS_REJECTED',
  permission_denied: 'WOOCOMMERCE_PERMISSION_DENIED',
  budget_exceeded: 'WOOCOMMERCE_PROVIDER_UNAVAILABLE',
};

/** A failure while reaching the REST API itself: the probe and the key proof. */
export function restFailureCode(
  reason: WooCommerceCallFailure,
): WooCommerceErrorCode {
  return (
    STORE_FAILURE_CODES[reason] ??
    (reason === 'rest_not_found'
      ? 'WOOCOMMERCE_REST_NOT_FOUND'
      : 'WOOCOMMERCE_REST_UNREACHABLE')
  );
}

/** A failure while replacing the webhooks, after the keys were proven. */
export function webhookFailureCode(
  reason: WooCommerceCallFailure,
): WooCommerceErrorCode {
  return STORE_FAILURE_CODES[reason] ?? 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED';
}

/** A failure while re-enabling a webhook that the store was reached for. */
export function webhookEnableFailureCode(
  reason: WooCommerceCallFailure,
): WooCommerceErrorCode {
  return STORE_FAILURE_CODES[reason] ?? 'WOOCOMMERCE_WEBHOOK_ENABLE_FAILED';
}

export function wooCommerceError(code: WooCommerceErrorCode): HttpException {
  const status = STATUS[code];
  return new HttpException(
    {
      statusCode: status,
      error: ERROR_NAME[status],
      message: MESSAGES[code],
      code,
    },
    status,
  );
}
