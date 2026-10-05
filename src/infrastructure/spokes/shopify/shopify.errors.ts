import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * The codes the Shopify spoke answers with. A client matches on the code, so
 * these are never renamed.
 */
export type ShopifyErrorCode =
  | 'SHOPIFY_WEBHOOK_UNAUTHORIZED'
  | 'SHOPIFY_WEBHOOK_IDENTITY_INVALID'
  | 'SHOPIFY_BILLING_UNAVAILABLE'
  | 'SHOPIFY_BILLING_CALLBACK_INVALID'
  | 'SHOPIFY_BILLING_CALLBACK_UNAUTHORIZED'
  | 'SHOPIFY_SHOP_INVALID'
  | 'SHOPIFY_AUTH_PARAMETERS_MISSING'
  | 'SHOPIFY_HMAC_INVALID'
  | 'SHOPIFY_OAUTH_STATE_INVALID'
  | 'SHOPIFY_SESSION_TOKEN_INVALID'
  | 'SHOPIFY_TOKEN_EXCHANGE_FAILED'
  | 'SHOPIFY_ACCOUNT_PROVISIONING_FAILED'
  | 'SHOPIFY_WEBHOOK_REGISTRATION_FAILED';

type ShopifyErrorStatus =
  | HttpStatus.BAD_REQUEST
  | HttpStatus.UNAUTHORIZED
  | HttpStatus.FORBIDDEN
  | HttpStatus.INTERNAL_SERVER_ERROR;

const STATUS: Record<ShopifyErrorCode, ShopifyErrorStatus> = {
  SHOPIFY_WEBHOOK_UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  SHOPIFY_WEBHOOK_IDENTITY_INVALID: HttpStatus.BAD_REQUEST,
  SHOPIFY_BILLING_UNAVAILABLE: HttpStatus.FORBIDDEN,
  SHOPIFY_BILLING_CALLBACK_INVALID: HttpStatus.BAD_REQUEST,
  SHOPIFY_BILLING_CALLBACK_UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  SHOPIFY_SHOP_INVALID: HttpStatus.BAD_REQUEST,
  SHOPIFY_AUTH_PARAMETERS_MISSING: HttpStatus.BAD_REQUEST,
  SHOPIFY_HMAC_INVALID: HttpStatus.UNAUTHORIZED,
  SHOPIFY_OAUTH_STATE_INVALID: HttpStatus.UNAUTHORIZED,
  SHOPIFY_SESSION_TOKEN_INVALID: HttpStatus.UNAUTHORIZED,
  SHOPIFY_TOKEN_EXCHANGE_FAILED: HttpStatus.INTERNAL_SERVER_ERROR,
  SHOPIFY_ACCOUNT_PROVISIONING_FAILED: HttpStatus.INTERNAL_SERVER_ERROR,
  SHOPIFY_WEBHOOK_REGISTRATION_FAILED: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * The exception class per status. These sites threw the Nest class before
 * they had a code, and callers and specs may match on it, so the class is
 * kept and only the code is added to the body.
 */
const EXCEPTION: Record<
  ShopifyErrorStatus,
  { error: string; create: (body: object) => HttpException }
> = {
  [HttpStatus.BAD_REQUEST]: {
    error: 'Bad Request',
    create: (body) => new BadRequestException(body),
  },
  [HttpStatus.UNAUTHORIZED]: {
    error: 'Unauthorized',
    create: (body) => new UnauthorizedException(body),
  },
  [HttpStatus.FORBIDDEN]: {
    error: 'Forbidden',
    create: (body) => new ForbiddenException(body),
  },
  [HttpStatus.INTERNAL_SERVER_ERROR]: {
    error: 'Internal Server Error',
    create: (body) => new InternalServerErrorException(body),
  },
};

/**
 * The message is given per site: several checks share one code and each
 * keeps the text it always answered with.
 */
export function shopifyError(
  code: ShopifyErrorCode,
  message: string,
): HttpException {
  const statusCode = STATUS[code];
  const { error, create } = EXCEPTION[statusCode];
  return create({ statusCode, error, message, code });
}
