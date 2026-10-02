import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The codes key management and the API key guard answer with, beside the
 * source and role codes in `API_KEY_SOURCE_CODES`. The frontend translates
 * by code, so these are never renamed.
 */
export type IntegrationKeyErrorCode =
  | 'API_KEY_VALIDATION_FAILED'
  | 'API_KEY_NOT_FOUND'
  | 'API_KEY_LIMIT_REACHED'
  | 'API_KEY_INVALID';

const STATUS: Record<IntegrationKeyErrorCode, HttpStatus> = {
  API_KEY_VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  API_KEY_NOT_FOUND: HttpStatus.NOT_FOUND,
  API_KEY_LIMIT_REACHED: HttpStatus.CONFLICT,
  API_KEY_INVALID: HttpStatus.UNAUTHORIZED,
};

const MESSAGES: Record<IntegrationKeyErrorCode, string> = {
  API_KEY_VALIDATION_FAILED: 'The API key request is invalid.',
  API_KEY_NOT_FOUND: 'API key not found.',
  API_KEY_LIMIT_REACHED:
    'This store already has the maximum number of active API keys. Revoke one first.',
  // One answer for every authentication failure: it never says whether the
  // key exists, was revoked or was mistyped.
  API_KEY_INVALID: 'A valid API key is required.',
};

const ERROR_NAME: Record<IntegrationKeyErrorCode, string> = {
  API_KEY_VALIDATION_FAILED: 'Bad Request',
  API_KEY_NOT_FOUND: 'Not Found',
  API_KEY_LIMIT_REACHED: 'Conflict',
  API_KEY_INVALID: 'Unauthorized',
};

export function integrationKeyError(
  code: IntegrationKeyErrorCode,
  extra: Record<string, unknown> = {},
): HttpException {
  const status = STATUS[code];
  return new HttpException(
    {
      statusCode: status,
      error: ERROR_NAME[code],
      message: MESSAGES[code],
      code,
      ...extra,
    },
    status,
  );
}
