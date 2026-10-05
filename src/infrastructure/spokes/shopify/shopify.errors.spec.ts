import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { shopifyError, type ShopifyErrorCode } from './shopify.errors';

type ExceptionClass =
  | typeof BadRequestException
  | typeof UnauthorizedException
  | typeof ForbiddenException
  | typeof InternalServerErrorException;

// The class and status each site threw before it had a code. A change here
// changes what a client is answered with.
const CASES: [ShopifyErrorCode, number, string, ExceptionClass][] = [
  ['SHOPIFY_WEBHOOK_UNAUTHORIZED', 401, 'Unauthorized', UnauthorizedException],
  ['SHOPIFY_WEBHOOK_IDENTITY_INVALID', 400, 'Bad Request', BadRequestException],
  ['SHOPIFY_BILLING_UNAVAILABLE', 403, 'Forbidden', ForbiddenException],
  ['SHOPIFY_BILLING_CALLBACK_INVALID', 400, 'Bad Request', BadRequestException],
  [
    'SHOPIFY_BILLING_CALLBACK_UNAUTHORIZED',
    401,
    'Unauthorized',
    UnauthorizedException,
  ],
  ['SHOPIFY_SHOP_INVALID', 400, 'Bad Request', BadRequestException],
  ['SHOPIFY_AUTH_PARAMETERS_MISSING', 400, 'Bad Request', BadRequestException],
  ['SHOPIFY_HMAC_INVALID', 401, 'Unauthorized', UnauthorizedException],
  ['SHOPIFY_OAUTH_STATE_INVALID', 401, 'Unauthorized', UnauthorizedException],
  ['SHOPIFY_SESSION_TOKEN_INVALID', 401, 'Unauthorized', UnauthorizedException],
  [
    'SHOPIFY_TOKEN_EXCHANGE_FAILED',
    500,
    'Internal Server Error',
    InternalServerErrorException,
  ],
  [
    'SHOPIFY_ACCOUNT_PROVISIONING_FAILED',
    500,
    'Internal Server Error',
    InternalServerErrorException,
  ],
  [
    'SHOPIFY_WEBHOOK_REGISTRATION_FAILED',
    500,
    'Internal Server Error',
    InternalServerErrorException,
  ],
];

describe('shopifyError', () => {
  it.each(CASES)(
    '%s answers %d with the Nest class the site always threw',
    (code, status, error, exceptionClass) => {
      const exception = shopifyError(code, 'What the site says');

      expect(exception).toBeInstanceOf(exceptionClass);
      expect(exception.getStatus()).toBe(status);
      expect(exception.getResponse()).toEqual({
        statusCode: status,
        error,
        message: 'What the site says',
        code,
      });
    },
  );

  it('keeps the message of each site readable on the exception', () => {
    // Specs and logs read `error.message`, as they did with a string body.
    expect(
      shopifyError('SHOPIFY_OAUTH_STATE_INVALID', 'State expired').message,
    ).toBe('State expired');
  });

  it('gives sites under one code their own message', () => {
    const expired = shopifyError(
      'SHOPIFY_OAUTH_STATE_INVALID',
      'State expired',
    );
    const mismatch = shopifyError(
      'SHOPIFY_OAUTH_STATE_INVALID',
      'State does not match shop',
    );

    expect(expired.getResponse()).toMatchObject({
      code: 'SHOPIFY_OAUTH_STATE_INVALID',
      message: 'State expired',
    });
    expect(mismatch.getResponse()).toMatchObject({
      code: 'SHOPIFY_OAUTH_STATE_INVALID',
      message: 'State does not match shop',
    });
  });
});
