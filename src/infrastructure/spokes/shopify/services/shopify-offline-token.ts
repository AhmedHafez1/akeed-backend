/**
 * Expiring Shopify offline tokens: a 1-hour access token plus a rotating
 * refresh token. Every grant (ID-token exchange, authorization code, refresh
 * and the move from a non-expiring token) answers with the same four fields.
 */

export const TOKEN_EXCHANGE_GRANT =
  'urn:ietf:params:oauth:grant-type:token-exchange';
export const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
export const OFFLINE_ACCESS_TOKEN_TYPE =
  'urn:shopify:params:oauth:token-type:offline-access-token';
export const REFRESH_TOKEN_GRANT = 'refresh_token';
/** Shopify reads the flag as a string, as its own app library sends it. */
export const EXPIRING_FLAG = '1';

/** Stored expiries are pulled this much earlier than Shopify's. */
export const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** An access token closer than this to its expiry is renewed before use. */
export const ACCESS_TOKEN_RENEW_BEFORE_MS = 5 * 60_000;
/** Opening the app re-acquires a pair whose refresh token ends this soon. */
export const REFRESH_TOKEN_REACQUIRE_BEFORE_MS = 7 * 24 * 60 * 60_000;
/** The keep-alive renews a refresh token that ends this soon. */
export const REFRESH_TOKEN_KEEP_ALIVE_BEFORE_MS = 14 * 24 * 60 * 60_000;

export interface ShopifyOfflineTokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  scope?: string;
}

export class ShopifyTokenResponseInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Shopify token response has no valid ${field}`);
    this.name = 'ShopifyTokenResponseInvalidError';
  }
}

/**
 * How a call to Shopify's token endpoint failed.
 * - `rejected`: the grant is dead (expired or replaced refresh token, revoked
 *   app); only the merchant reopening the app gets a new one.
 * - `invalid_subject_token`: the token offered for the move is not an active
 *   non-expiring token.
 * - `transient`: network, timeout, 429 or 5xx; retrying later may work.
 * - `failed`: any other answer; neither retried blindly nor treated as dead.
 */
export type ShopifyTokenFailureKind =
  | 'rejected'
  | 'invalid_subject_token'
  | 'transient'
  | 'failed';

export class ShopifyTokenRequestError extends Error {
  constructor(
    readonly kind: ShopifyTokenFailureKind,
    readonly httpStatus: number | undefined,
    readonly providerError: string | undefined,
  ) {
    super(`Shopify token request failed (${kind})`);
    this.name = 'ShopifyTokenRequestError';
  }
}

/** The store's Shopify credential is dead until the merchant reopens Akeed. */
export class ShopifyReauthRequiredError extends Error {
  readonly code = 'SHOPIFY_REAUTH_REQUIRED';
  constructor(
    readonly shopDomain: string,
    readonly reason: string,
  ) {
    super(
      `Shopify access for ${shopDomain} needs the merchant to reopen Akeed`,
    );
    this.name = 'ShopifyReauthRequiredError';
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveSeconds(value: unknown): number | undefined {
  const seconds = typeof value === 'string' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0
    ? seconds
    : undefined;
}

/** Reads a token-endpoint answer; values never appear in the error. */
export function parseExpiringTokenResponse(
  data: unknown,
  now: Date = new Date(),
): ShopifyOfflineTokenPair {
  const body = (data ?? {}) as Record<string, unknown>;
  if (!nonEmptyString(body.access_token))
    throw new ShopifyTokenResponseInvalidError('access_token');
  if (!nonEmptyString(body.refresh_token))
    throw new ShopifyTokenResponseInvalidError('refresh_token');
  const expiresIn = positiveSeconds(body.expires_in);
  if (expiresIn === undefined)
    throw new ShopifyTokenResponseInvalidError('expires_in');
  const refreshExpiresIn = positiveSeconds(body.refresh_token_expires_in);
  if (refreshExpiresIn === undefined)
    throw new ShopifyTokenResponseInvalidError('refresh_token_expires_in');

  const nowMs = now.getTime();
  const accessMs = Math.max(
    expiresIn * 1000 - ACCESS_TOKEN_EXPIRY_MARGIN_MS,
    0,
  );
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessTokenExpiresAt: new Date(nowMs + accessMs).toISOString(),
    refreshTokenExpiresAt: new Date(
      nowMs + refreshExpiresIn * 1000,
    ).toISOString(),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  };
}

/** Sorts a token-endpoint failure by what the caller should do next. */
export function classifyTokenFailure(
  httpStatus: number | undefined,
  responseData: unknown,
): ShopifyTokenRequestError {
  const providerError =
    responseData &&
    typeof responseData === 'object' &&
    typeof (responseData as { error?: unknown }).error === 'string'
      ? (responseData as { error: string }).error.slice(0, 64)
      : undefined;
  if (httpStatus === undefined || httpStatus === 429 || httpStatus >= 500)
    return new ShopifyTokenRequestError('transient', httpStatus, providerError);
  if (providerError === 'invalid_subject_token')
    return new ShopifyTokenRequestError(
      'invalid_subject_token',
      httpStatus,
      providerError,
    );
  if (
    httpStatus === 401 ||
    (httpStatus === 400 &&
      (providerError === 'invalid_request' ||
        providerError === 'invalid_grant'))
  )
    return new ShopifyTokenRequestError('rejected', httpStatus, providerError);
  return new ShopifyTokenRequestError('failed', httpStatus, providerError);
}

/** Shopify's 403 for a non-expiring token once those stop being accepted. */
export function isLegacyTokenRejection(
  httpStatus: number | undefined,
  responseData: unknown,
): boolean {
  if (httpStatus !== 403) return false;
  const text =
    typeof responseData === 'string'
      ? responseData
      : JSON.stringify(responseData ?? '');
  return /non-expiring access tokens are no longer accepted/i.test(text);
}
