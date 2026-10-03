import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The codes the EasyOrders connection answers with. The frontend translates
 * by code, so these are never renamed.
 */
export type EasyOrdersErrorCode =
  | 'EASYORDERS_CONNECT_UNAVAILABLE'
  | 'EASYORDERS_PILOT_REQUIRED'
  | 'EASYORDERS_SESSION_REQUIRED'
  | 'EASYORDERS_SOURCE_EXISTS'
  | 'EASYORDERS_INSTALL_VALIDATION_FAILED'
  | 'EASYORDERS_INSTALL_CONTEXT_INVALID'
  | 'EASYORDERS_CALLBACK_INVALID'
  | 'EASYORDERS_KEY_REJECTED'
  | 'EASYORDERS_PROVIDER_UNAVAILABLE'
  | 'EASYORDERS_STORE_UNAVAILABLE'
  | 'EASYORDERS_RECONNECT_STORE_MISMATCH'
  | 'EASYORDERS_NOT_CONNECTED'
  | 'EASYORDERS_SECRETS_INVALID'
  | 'EASYORDERS_ORDER_SETTINGS_INVALID'
  | 'EASYORDERS_INGESTION_UNAVAILABLE'
  | 'EASYORDERS_WEBHOOK_UNAUTHORIZED'
  | 'EASYORDERS_WEBHOOK_STORE_MISMATCH'
  | 'EASYORDERS_WEBHOOK_MALFORMED';

/** Used with `assertOrganizationWriteAllowed`; viewers are read-only. */
export const EASYORDERS_ROLE_REQUIRED = {
  code: 'EASYORDERS_ROLE_REQUIRED',
  message:
    'Owner or admin role is required to manage the EasyOrders connection',
} as const;

const STATUS: Record<EasyOrdersErrorCode, HttpStatus> = {
  EASYORDERS_CONNECT_UNAVAILABLE: HttpStatus.NOT_FOUND,
  EASYORDERS_PILOT_REQUIRED: HttpStatus.FORBIDDEN,
  EASYORDERS_SESSION_REQUIRED: HttpStatus.FORBIDDEN,
  EASYORDERS_SOURCE_EXISTS: HttpStatus.CONFLICT,
  EASYORDERS_INSTALL_VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  EASYORDERS_INSTALL_CONTEXT_INVALID: HttpStatus.UNAUTHORIZED,
  EASYORDERS_CALLBACK_INVALID: HttpStatus.BAD_REQUEST,
  EASYORDERS_KEY_REJECTED: HttpStatus.UNPROCESSABLE_ENTITY,
  EASYORDERS_PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  EASYORDERS_STORE_UNAVAILABLE: HttpStatus.CONFLICT,
  EASYORDERS_RECONNECT_STORE_MISMATCH: HttpStatus.CONFLICT,
  EASYORDERS_NOT_CONNECTED: HttpStatus.NOT_FOUND,
  EASYORDERS_SECRETS_INVALID: HttpStatus.BAD_REQUEST,
  EASYORDERS_ORDER_SETTINGS_INVALID: HttpStatus.BAD_REQUEST,
  EASYORDERS_INGESTION_UNAVAILABLE: HttpStatus.NOT_FOUND,
  EASYORDERS_WEBHOOK_UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  EASYORDERS_WEBHOOK_STORE_MISMATCH: HttpStatus.FORBIDDEN,
  EASYORDERS_WEBHOOK_MALFORMED: HttpStatus.BAD_REQUEST,
};

const MESSAGES: Record<EasyOrdersErrorCode, string> = {
  EASYORDERS_CONNECT_UNAVAILABLE: 'EasyOrders connection is not available.',
  EASYORDERS_PILOT_REQUIRED:
    'This organization is not approved for the EasyOrders pilot yet.',
  EASYORDERS_SESSION_REQUIRED:
    'EasyOrders can only be connected from an Akeed account session.',
  EASYORDERS_SOURCE_EXISTS:
    'This organization already has a commerce source and cannot connect another.',
  EASYORDERS_INSTALL_VALIDATION_FAILED: 'The install request is invalid.',
  // One answer for an unknown, expired, used or replaced install link: it
  // never says which.
  EASYORDERS_INSTALL_CONTEXT_INVALID: 'This install link is not valid.',
  EASYORDERS_CALLBACK_INVALID: 'The install callback is invalid.',
  EASYORDERS_KEY_REJECTED: 'EasyOrders did not accept the API key.',
  EASYORDERS_PROVIDER_UNAVAILABLE:
    'EasyOrders could not be reached to check the API key.',
  EASYORDERS_STORE_UNAVAILABLE:
    'This EasyOrders store is already connected to another account.',
  EASYORDERS_RECONNECT_STORE_MISMATCH:
    'Only the EasyOrders store that was connected before can be reconnected.',
  EASYORDERS_NOT_CONNECTED: 'EasyOrders is not connected.',
  EASYORDERS_SECRETS_INVALID: 'The webhook secrets are invalid.',
  EASYORDERS_ORDER_SETTINGS_INVALID:
    'The store currency or phone country is invalid.',
  EASYORDERS_INGESTION_UNAVAILABLE: 'Not Found',
  // One answer for an unknown or rotated URL token, a disconnected source and
  // a missing or wrong secret: it never says which.
  EASYORDERS_WEBHOOK_UNAUTHORIZED: 'The webhook is not authorized.',
  EASYORDERS_WEBHOOK_STORE_MISMATCH:
    'The webhook does not belong to the connected store.',
  EASYORDERS_WEBHOOK_MALFORMED: 'The webhook payload is not supported.',
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

export function easyOrdersError(
  code: EasyOrdersErrorCode,
  extra: Record<string, unknown> = {},
): HttpException {
  const status = STATUS[code];
  return new HttpException(
    {
      statusCode: status,
      error: ERROR_NAME[status],
      message: MESSAGES[code],
      code,
      ...extra,
    },
    status,
  );
}
