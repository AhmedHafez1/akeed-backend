import { Inject, Injectable } from '@nestjs/common';
import {
  RESTRICTED_HTTP_MAX_BYTES,
  RestrictedHttpError,
  type RestrictedHttp,
  type RestrictedHttpRequest,
  type RestrictedHttpResponse,
} from '../../../shared/http/restricted-http';

export const WOOCOMMERCE_HTTP = Symbol('WOOCOMMERCE_HTTP');

export const WOOCOMMERCE_REST_BASE_PATH = '/wp-json/wc/v3';

/** Most webhooks one page may hold; the store's own maximum. */
export const WOOCOMMERCE_WEBHOOKS_PER_PAGE = 100;

export interface WooCommerceCredentials {
  consumerKey: string;
  consumerSecret: string;
}

/**
 * Why a call gave no usable answer. Codes only: nothing the store said is
 * kept, and its `message` and `code` fields are never parsed (worst-case
 * rule for findings 2.6 and 2.8).
 *
 * - `address_not_public`, `redirects`, `tls_failed`: refused by the
 *   restricted client.
 * - `rest_not_found`: a 404.
 * - `credentials_rejected`: a 401. `permission_denied`: a 403.
 * - `budget_exceeded`: the caller's own deadline passed.
 * - `unreachable`: no answer, the call's deadline, a 5xx, a 429, a body that
 *   is not the JSON expected, or anything else.
 */
export type WooCommerceCallFailure =
  | 'address_not_public'
  | 'redirects'
  | 'tls_failed'
  | 'rest_not_found'
  | 'credentials_rejected'
  | 'permission_denied'
  | 'budget_exceeded'
  | 'unreachable';

export type WooCommerceCallResult<T> =
  | ({ kind: 'ok' } & T)
  | { kind: 'failed'; reason: WooCommerceCallFailure };

export interface WooCommerceWebhookSummary {
  id: number;
  deliveryUrl: string;
}

export interface NewWooCommerceWebhook {
  name: string;
  topic: string;
  deliveryUrl: string;
  secret: string;
}

type Exchange =
  | { kind: 'answered'; response: RestrictedHttpResponse }
  | { kind: 'failed'; reason: WooCommerceCallFailure };

function failed(reason: WooCommerceCallFailure) {
  return { kind: 'failed' as const, reason };
}

function basicAuthorization(credentials: WooCommerceCredentials): string {
  return `Basic ${Buffer.from(
    `${credentials.consumerKey}:${credentials.consumerSecret}`,
    'utf8',
  ).toString('base64')}`;
}

function readJson(response: RestrictedHttpResponse): unknown {
  try {
    return JSON.parse(response.body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** What an authenticated call's status means when it is not a success. */
function statusFailure(status: number): WooCommerceCallFailure {
  if (status === 401) return 'credentials_rejected';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'rest_not_found';
  return 'unreachable';
}

/**
 * Every REST call to a store, on the restricted outbound client. The URL is
 * always the stored canonical store URL plus a fixed path; no part of it
 * comes from a payload or a response. One attempt per call: the caller owns
 * any repeat. Keys, secrets and response bodies never leave this class.
 */
@Injectable()
export class WooCommerceApiClient {
  constructor(
    @Inject(WOOCOMMERCE_HTTP) private readonly http: RestrictedHttp,
  ) {}

  /**
   * The unauthenticated look at `wp-json/wc/v3` before the merchant is sent
   * to the store. What that address returns is not documented, so only the
   * status is read: a 404 means the REST API is not there, a 5xx means the
   * store is failing, and any other answer lets the merchant continue.
   */
  async probeRestApi(storeUrl: string): Promise<WooCommerceCallResult<object>> {
    const exchange = await this.exchange({
      url: `${storeUrl}${WOOCOMMERCE_REST_BASE_PATH}`,
      method: 'GET',
    });
    if (exchange.kind === 'failed') return exchange;
    const { status } = exchange.response;
    if (status === 404) return failed('rest_not_found');
    if (status >= 500) return failed('unreachable');
    return { kind: 'ok' };
  }

  /**
   * Proves the keys: a 200 with a JSON object that has a string
   * `environment.home_url`. Nothing else in the body is trusted or kept,
   * except the version, for support.
   */
  async readSystemStatus(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    signal?: AbortSignal,
  ): Promise<
    WooCommerceCallResult<{ homeUrl: string; version: string | null }>
  > {
    const exchange = await this.exchange({
      url: `${storeUrl}${WOOCOMMERCE_REST_BASE_PATH}/system_status`,
      method: 'GET',
      authorization: basicAuthorization(credentials),
      maxResponseBytes: RESTRICTED_HTTP_MAX_BYTES,
      signal,
    });
    if (exchange.kind === 'failed') return exchange;
    if (exchange.response.status !== 200)
      return failed(statusFailure(exchange.response.status));
    const body = readJson(exchange.response);
    const environment = isRecord(body) ? body.environment : undefined;
    if (!isRecord(environment) || typeof environment.home_url !== 'string')
      return failed('unreachable');
    return {
      kind: 'ok',
      homeUrl: environment.home_url,
      version:
        typeof environment.version === 'string' ? environment.version : null,
    };
  }

  /** `totalPages` is null when the store did not say. */
  async listWebhooks(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    page: number,
    signal?: AbortSignal,
  ): Promise<
    WooCommerceCallResult<{
      webhooks: WooCommerceWebhookSummary[];
      totalPages: number | null;
    }>
  > {
    const exchange = await this.exchange({
      url: `${storeUrl}${WOOCOMMERCE_REST_BASE_PATH}/webhooks?per_page=${WOOCOMMERCE_WEBHOOKS_PER_PAGE}&page=${page}`,
      method: 'GET',
      authorization: basicAuthorization(credentials),
      signal,
    });
    if (exchange.kind === 'failed') return exchange;
    if (exchange.response.status !== 200)
      return failed(statusFailure(exchange.response.status));
    const body = readJson(exchange.response);
    if (!Array.isArray(body)) return failed('unreachable');
    const webhooks: WooCommerceWebhookSummary[] = [];
    for (const entry of body as unknown[]) {
      // An entry that cannot be read could be one of Akeed's own.
      if (
        !isRecord(entry) ||
        !isPositiveInteger(entry.id) ||
        typeof entry.delivery_url !== 'string'
      )
        return failed('unreachable');
      webhooks.push({ id: entry.id, deliveryUrl: entry.delivery_url });
    }
    const totalPages = Number(exchange.response.headers['x-wp-totalpages']);
    return {
      kind: 'ok',
      webhooks,
      totalPages: Number.isSafeInteger(totalPages) ? totalPages : null,
    };
  }

  async createWebhook(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    webhook: NewWooCommerceWebhook,
    signal?: AbortSignal,
  ): Promise<WooCommerceCallResult<{ id: number }>> {
    const exchange = await this.exchange({
      url: `${storeUrl}${WOOCOMMERCE_REST_BASE_PATH}/webhooks`,
      method: 'POST',
      authorization: basicAuthorization(credentials),
      contentType: 'application/json',
      body: JSON.stringify({
        name: webhook.name,
        status: 'active',
        topic: webhook.topic,
        delivery_url: webhook.deliveryUrl,
        secret: webhook.secret,
      }),
      signal,
    });
    if (exchange.kind === 'failed') return exchange;
    const { status } = exchange.response;
    if (status < 200 || status >= 300) return failed(statusFailure(status));
    const body = readJson(exchange.response);
    return isRecord(body) && isPositiveInteger(body.id)
      ? { kind: 'ok', id: body.id }
      : failed('unreachable');
  }

  /** A webhook that is already gone counts as deleted. */
  async deleteWebhook(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    webhookId: number,
    signal?: AbortSignal,
  ): Promise<WooCommerceCallResult<object>> {
    const exchange = await this.exchange({
      url: `${storeUrl}${WOOCOMMERCE_REST_BASE_PATH}/webhooks/${webhookId}?force=true`,
      method: 'DELETE',
      authorization: basicAuthorization(credentials),
      signal,
    });
    if (exchange.kind === 'failed') return exchange;
    const { status } = exchange.response;
    if ((status >= 200 && status < 300) || status === 404)
      return { kind: 'ok' };
    return failed(statusFailure(status));
  }

  private async exchange(request: RestrictedHttpRequest): Promise<Exchange> {
    try {
      return { kind: 'answered', response: await this.http(request) };
    } catch (error) {
      if (!(error instanceof RestrictedHttpError)) return failed('unreachable');
      switch (error.code) {
        case 'address_not_public':
          return failed('address_not_public');
        case 'redirect':
          return failed('redirects');
        case 'tls_failed':
          return failed('tls_failed');
        case 'timeout':
          return failed(
            request.signal?.aborted ? 'budget_exceeded' : 'unreachable',
          );
        default:
          return failed('unreachable');
      }
    }
  }
}
