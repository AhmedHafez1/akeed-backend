import { Inject, Injectable } from '@nestjs/common';
import {
  RESTRICTED_HTTP_MAX_BYTES,
  RestrictedHttpError,
  type RestrictedHttp,
  type RestrictedHttpRequest,
  type RestrictedHttpResponse,
} from '../../../shared/http/restricted-http';
import { WOOCOMMERCE_OUTCOME_META_KEY } from './woocommerce-delivery';
import { readWooCommerceOrderId } from './woocommerce-ingestion.policy';
import {
  readWooCommerceOutcomeMarkers,
  readWooCommerceStatus,
} from './woocommerce-outcome.mapping';
import { canonicalizeWooCommerceStoreUrl } from './woocommerce-store-url';

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

/** The three states a webhook has at the store (finding 3.15). */
export const WOOCOMMERCE_WEBHOOK_STATUSES = [
  'active',
  'paused',
  'disabled',
] as const;
export type WooCommerceWebhookStatus =
  (typeof WOOCOMMERCE_WEBHOOK_STATUSES)[number];

/**
 * - `found`: the store has the webhook; `status` is null when its value is
 *   not one of the documented three.
 * - `missing`: a 404. The webhook was deleted at the store.
 */
export type WooCommerceWebhookRead =
  | { kind: 'found'; status: WooCommerceWebhookStatus | null }
  | { kind: 'missing' }
  | { kind: 'failed'; reason: WooCommerceCallFailure };

export type WooCommerceWebhookWrite =
  | { kind: 'ok' }
  | { kind: 'missing' }
  | { kind: 'failed'; reason: WooCommerceCallFailure };

export interface NewWooCommerceWebhook {
  name: string;
  topic: string;
  deliveryUrl: string;
  secret: string;
}

/** What Akeed reads of an order, once the answer is proven to be this store's. */
export interface WooCommerceOrderState {
  /** Null when the store's value is not a status name. */
  status: string | null;
  /** The values of the order's `akeed_outcome` meta entries. */
  markers: string[];
}

/**
 * Why an order call gave no usable answer (contract record, section 5).
 *
 * - `credentials_rejected`: a 401. `permission_denied`: a 403.
 * - `not_found`: a 404 on the order.
 * - `throttled`: a 429 or a 503, with the wait the answer named if any.
 * - `unavailable`: no verdict, and nothing was changed.
 * - `refused`: the restricted client would not make the call or keep its
 *   answer. Not something a retry clears.
 */
export type WooCommerceOrderCallFailure =
  | { kind: 'credentials_rejected' }
  | { kind: 'permission_denied' }
  | { kind: 'not_found' }
  | { kind: 'throttled'; status: 429 | 503; retryAfterMs: number | null }
  | { kind: 'unavailable' }
  | { kind: 'refused' };

/** `unverified`: an answer that does not prove it is this store's order. */
export type WooCommerceOrderRead =
  | { kind: 'found'; order: WooCommerceOrderState }
  | { kind: 'unverified' }
  | WooCommerceOrderCallFailure;

/**
 * - `updated`: a 2xx carrying this store's order, as it is after the write.
 * - `rejected`: the store refused the change.
 * - `method_refused`: a 405 or a 501; the host does not accept `PUT`.
 * - `ambiguous`: the write may or may not have been taken. The order has to
 *   be read before anything is tried again.
 */
export type WooCommerceOrderWrite =
  | { kind: 'updated'; order: WooCommerceOrderState }
  | { kind: 'rejected' }
  | { kind: 'method_refused' }
  | { kind: 'ambiguous' }
  | WooCommerceOrderCallFailure;

export interface WooCommerceOrderChange {
  /** The value of the `akeed_outcome` meta entry to add. */
  marker: string;
  /** Sent only when the outcome changes the status. */
  status?: string;
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
 * `Retry-After` in seconds or as an HTTP date (rule 8.1); null when absent or
 * unreadable. A long wait is kept: the outcome sync policy clamps it.
 */
export function parseRetryAfter(
  header: string | undefined,
  now: number,
): number | null {
  const value = header?.trim();
  if (!value) return null;
  let delayMs = Number.NaN;
  if (/^\d{1,9}$/.test(value)) delayMs = Number(value) * 1_000;
  // An HTTP date starts with the day's name; `Date.parse` alone would read
  // a bare number as a date too.
  else if (/^[A-Za-z]/.test(value)) delayMs = Date.parse(value) - now;
  return Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : null;
}

/** What an order call's status means, the same for a read and a write. */
function orderStatusFailure(
  response: RestrictedHttpResponse,
): WooCommerceOrderCallFailure | undefined {
  const { status } = response;
  if (status === 401) return { kind: 'credentials_rejected' };
  if (status === 403) return { kind: 'permission_denied' };
  if (status === 404) return { kind: 'not_found' };
  if (status === 429 || status === 503)
    return {
      kind: 'throttled',
      status,
      retryAfterMs: parseRetryAfter(
        response.headers['retry-after'],
        Date.now(),
      ),
    };
  return undefined;
}

/** An order id as it goes into a path: decimal digits and nothing else. */
const ORDER_ID_PATTERN = /^[1-9]\d{0,15}$/;

/**
 * The order in an answer, only when the answer is this store's order: its
 * `id` is the one asked for and its own link is that order's address under
 * the canonical store URL (finding 5.7). Equality, not a prefix: a store at
 * a domain's root must not take the answer of one in a subdirectory.
 */
function readOrderOf(
  storeUrl: string,
  orderId: string,
  body: unknown,
): WooCommerceOrderState | null {
  if (!isRecord(body) || readWooCommerceOrderId(body.id) !== orderId)
    return null;
  const links = isRecord(body._links) ? body._links.self : undefined;
  const self: unknown = Array.isArray(links) ? links[0] : undefined;
  const href = isRecord(self) ? self.href : undefined;
  const path = `${WOOCOMMERCE_REST_BASE_PATH}/orders/${orderId}`;
  if (typeof href !== 'string' || !href.endsWith(path)) return null;
  const base = canonicalizeWooCommerceStoreUrl(href.slice(0, -path.length));
  if (!base.ok || base.url !== storeUrl) return null;
  return {
    status: readWooCommerceStatus(body.status),
    markers: readWooCommerceOutcomeMarkers(body.meta_data),
  };
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

  /**
   * One webhook's state as the store holds it. Only `status` is read, and
   * only from an answer that names the webhook asked for.
   */
  async getWebhook(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    webhookId: number,
    signal?: AbortSignal,
  ): Promise<WooCommerceWebhookRead> {
    const exchange = await this.exchange({
      url: `${storeUrl}${WOOCOMMERCE_REST_BASE_PATH}/webhooks/${webhookId}`,
      method: 'GET',
      authorization: basicAuthorization(credentials),
      signal,
    });
    if (exchange.kind === 'failed') return exchange;
    const { status } = exchange.response;
    if (status === 404) return { kind: 'missing' };
    if (status !== 200) return failed(statusFailure(status));
    const body = readJson(exchange.response);
    if (!isRecord(body) || body.id !== webhookId) return failed('unreachable');
    return {
      kind: 'found',
      status:
        WOOCOMMERCE_WEBHOOK_STATUSES.find((known) => known === body.status) ??
        null,
    };
  }

  /**
   * Sets a webhook back to `active` (finding 3.16). The answer's body is not
   * trusted: the caller reads the webhook again to confirm.
   */
  async enableWebhook(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    webhookId: number,
    signal?: AbortSignal,
  ): Promise<WooCommerceWebhookWrite> {
    const exchange = await this.exchange({
      url: `${storeUrl}${WOOCOMMERCE_REST_BASE_PATH}/webhooks/${webhookId}`,
      method: 'PUT',
      authorization: basicAuthorization(credentials),
      contentType: 'application/json',
      body: JSON.stringify({ status: 'active' }),
      signal,
    });
    if (exchange.kind === 'failed') return exchange;
    const { status } = exchange.response;
    if (status === 404) return { kind: 'missing' };
    if (status < 200 || status >= 300) return failed(statusFailure(status));
    return { kind: 'ok' };
  }

  /**
   * One read of an order. Nothing was changed whatever the answer is, so a
   * timeout or a broken connection is only `unavailable`.
   */
  async getOrder(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    orderId: string,
  ): Promise<WooCommerceOrderRead> {
    if (!ORDER_ID_PATTERN.test(orderId)) return { kind: 'not_found' };
    let response: RestrictedHttpResponse;
    try {
      response = await this.http({
        url: `${storeUrl}${WOOCOMMERCE_REST_BASE_PATH}/orders/${orderId}`,
        method: 'GET',
        authorization: basicAuthorization(credentials),
      });
    } catch (error) {
      return error instanceof RestrictedHttpError &&
        error.code !== 'timeout' &&
        error.code !== 'network'
        ? { kind: 'refused' }
        : { kind: 'unavailable' };
    }
    const failure = orderStatusFailure(response);
    if (failure) return failure;
    if (response.status !== 200)
      return response.status >= 200 && response.status < 300
        ? { kind: 'unverified' }
        : { kind: 'unavailable' };
    const order = readOrderOf(storeUrl, orderId, readJson(response));
    return order ? { kind: 'found', order } : { kind: 'unverified' };
  }

  /**
   * One `PUT` carrying the marker and, when the outcome has one, the status,
   * so a repeat cannot leave one without the other. Never `set_paid`.
   *
   * Once the request may have left, anything short of an answer that shows
   * the order is `ambiguous`: a timeout, a broken connection, a 5xx, a body
   * too large to keep, a 2xx that is not this store's order.
   */
  async updateOrder(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    orderId: string,
    change: WooCommerceOrderChange,
  ): Promise<WooCommerceOrderWrite> {
    if (!ORDER_ID_PATTERN.test(orderId)) return { kind: 'not_found' };
    let response: RestrictedHttpResponse;
    try {
      response = await this.http({
        url: `${storeUrl}${WOOCOMMERCE_REST_BASE_PATH}/orders/${orderId}`,
        method: 'PUT',
        authorization: basicAuthorization(credentials),
        contentType: 'application/json',
        body: JSON.stringify({
          ...(change.status ? { status: change.status } : {}),
          meta_data: [
            { key: WOOCOMMERCE_OUTCOME_META_KEY, value: change.marker },
          ],
        }),
      });
    } catch (error) {
      // Refused before a connection carried the request, or answered with a
      // redirect: the store took nothing.
      return error instanceof RestrictedHttpError &&
        error.code !== 'timeout' &&
        error.code !== 'network' &&
        error.code !== 'response_too_large'
        ? { kind: 'refused' }
        : { kind: 'ambiguous' };
    }
    const failure = orderStatusFailure(response);
    if (failure) return failure;
    const { status } = response;
    if (status === 405 || status === 501) return { kind: 'method_refused' };
    if (status >= 400 && status < 500) return { kind: 'rejected' };
    if (status < 200 || status >= 300) return { kind: 'ambiguous' };
    const order = readOrderOf(storeUrl, orderId, readJson(response));
    return order ? { kind: 'updated', order } : { kind: 'ambiguous' };
  }

  /**
   * Adds one internal order note (`customer_note: false`: the customer is not
   * shown it and not notified). Notes have no idempotency (finding 5.6), so
   * the caller sends this at most once and a failure is not retried.
   */
  async addOrderNote(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    orderId: string,
    note: string,
  ): Promise<boolean> {
    if (!ORDER_ID_PATTERN.test(orderId)) return false;
    try {
      const { status } = await this.http({
        url: `${storeUrl}${WOOCOMMERCE_REST_BASE_PATH}/orders/${orderId}/notes`,
        method: 'POST',
        authorization: basicAuthorization(credentials),
        contentType: 'application/json',
        body: JSON.stringify({ note, customer_note: false }),
      });
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
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
