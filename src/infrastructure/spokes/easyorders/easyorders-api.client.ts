import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { boundedCall, NO_RETRY } from '../../../shared/http/bounded-http';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';

export const EASYORDERS_API_BASE =
  'https://api.easy-orders.net/api/v1/external-apps';

/** The body an inactive store answers every authenticated call with. */
export const EASYORDERS_INACTIVE_STORE_MESSAGE =
  'Store not active or has over due';

/**
 * What an active store answers a valid key that reads an order nobody has:
 * a 400, not a 404 (observed 2026-10-08).
 */
export const EASYORDERS_RECORD_NOT_FOUND_MESSAGE = 'record not found';

/**
 * What a wrong and a missing key are answered with: also a 400, never a 401
 * or 403 (observed 2026-10-08). Only the message tells them apart.
 */
export const EASYORDERS_KEY_REFUSED_MESSAGES: readonly string[] = [
  'Api-Key not valid',
  'Api-Key not found',
];

const PROBE_DEADLINE_MS = 10_000;
const LOOKUP_DEADLINE_MS = 10_000;
const STATUS_UPDATE_DEADLINE_MS = 10_000;
const WEBHOOK_DELETE_DEADLINE_MS = 10_000;
/** A `Retry-After` longer than this is not believed. */
const MAX_RETRY_AFTER_MS = 10 * 60_000;

export const EASYORDERS_HTTP = Symbol('EASYORDERS_HTTP');
export type EasyOrdersHttp = typeof fetch;

/**
 * - `live`: the key was accepted: a 2xx, or the 400 that says the order does
 *   not exist, which only a recognized key on an active store gets.
 * - `store_inactive`: the key was recognized, the store is not active. A
 *   connection-health state, not a credential failure.
 * - `rejected`: anything else EasyOrders answered. Not a usable key.
 * - `unavailable`: no verdict (timeout, network failure, 429 or 5xx).
 */
export type EasyOrdersKeyProbe =
  | 'live'
  | 'store_inactive'
  | 'rejected'
  | 'unavailable';

/**
 * - `found`: the order, as EasyOrders returned it.
 * - `not_found`: this key cannot see such an order (404, or the 400 that
 *   says so).
 * - `store_inactive`: the key is recognized, the store is not active.
 * - `credentials_rejected`: 401, 403 or the 400 EasyOrders answers a wrong
 *   key with. Permanent until the merchant acts.
 * - `rate_limited`: 429, with the wait EasyOrders asked for if it gave one.
 * - `unavailable`: no verdict (timeout, network failure, 5xx, anything else).
 */
export type EasyOrdersOrderLookup =
  | { kind: 'found'; order: Record<string, unknown> }
  | { kind: 'not_found' }
  | { kind: 'store_inactive' }
  | { kind: 'credentials_rejected' }
  | { kind: 'rate_limited'; retryAfterMs: number | null }
  | { kind: 'unavailable' };

/**
 * - `updated`: EasyOrders answered 2xx.
 * - `ambiguous`: no answer, or a 5xx. The status may or may not have changed;
 *   the caller must read the order before trying again.
 * - `rate_limited`: 429. Not applied.
 * - `credentials_rejected`: 401, 403 or the 400 EasyOrders answers a wrong
 *   key with. Permanent until the merchant acts.
 * - `store_inactive`: the key is recognized, the store is not active.
 * - `not_found`: this key cannot see such an order (404, or the 400 that
 *   says so).
 * - `rejected`: any other answer, such as a transition EasyOrders refuses.
 */
export type EasyOrdersStatusUpdate =
  | { kind: 'updated' }
  | { kind: 'ambiguous' }
  | { kind: 'rate_limited'; retryAfterMs: number | null }
  | { kind: 'credentials_rejected' }
  | { kind: 'store_inactive' }
  | { kind: 'not_found' }
  | { kind: 'rejected' };

/**
 * - `removed`: EasyOrders answered 2xx.
 * - `not_found`: 404. No webhook with that address is left.
 * - `rejected`: any other answer, including a key refused under both headers.
 * - `unavailable`: no verdict (timeout, network failure, 429 or 5xx).
 */
export type EasyOrdersWebhookDelete =
  | 'removed'
  | 'not_found'
  | 'rejected'
  | 'unavailable';

@Injectable()
export class EasyOrdersApiClient {
  private readonly logger = new Logger(EasyOrdersApiClient.name);

  constructor(@Inject(EASYORDERS_HTTP) private readonly http: EasyOrdersHttp) {}

  /**
   * Asks EasyOrders whether a key is real, by reading an order that cannot
   * exist. The contract record names no endpoint that identifies a key.
   * EasyOrders answers a valid key, a wrong key and an inactive store all with
   * a 400, so the message decides: "record not found" and the inactive-store
   * message prove a recognized key, and so does a 2xx. Everything else fails
   * closed, a 404 included.
   *
   * One attempt, with a deadline. The key and the response body never leave
   * this method; a refusal logs the status alone, which is the only way to
   * tell afterwards what EasyOrders answered.
   */
  async probeKey(apiKey: string): Promise<EasyOrdersKeyProbe> {
    try {
      return await boundedCall<EasyOrdersKeyProbe>(
        async () => {
          const response = await this.http(
            `${EASYORDERS_API_BASE}/orders/${randomUUID()}`,
            {
              method: 'GET',
              headers: { 'Api-Key': apiKey, Accept: 'application/json' },
              redirect: 'error',
              signal: AbortSignal.timeout(PROBE_DEADLINE_MS),
            },
          );
          if (response.ok) return 'live';
          if (response.status === 429 || response.status >= 500)
            return 'unavailable';
          const refusal = await readRefusal(response);
          if (refusal === 'store_inactive') return 'store_inactive';
          if (refusal === 'not_found') return 'live';
          this.logger.warn(
            buildBackendLog(EasyOrdersApiClient.name, {
              action: 'easyorders-key-probe',
              outcome: 'failure',
              httpStatus: response.status,
            }),
          );
          return 'rejected';
        },
        { policy: NO_RETRY },
      );
    } catch {
      return 'unavailable';
    }
  }

  /**
   * Reads one order with the integration's own key. One attempt with a
   * deadline: the caller owns the retry, through the queue and the rate
   * budget. The key and the error bodies never leave this method.
   */
  async getOrder(
    apiKey: string,
    orderId: string,
    now: () => number = Date.now,
  ): Promise<EasyOrdersOrderLookup> {
    try {
      return await boundedCall<EasyOrdersOrderLookup>(
        async () => {
          const response = await this.http(
            `${EASYORDERS_API_BASE}/orders/${encodeURIComponent(orderId)}`,
            {
              method: 'GET',
              headers: { 'Api-Key': apiKey, Accept: 'application/json' },
              redirect: 'error',
              signal: AbortSignal.timeout(LOOKUP_DEADLINE_MS),
            },
          );
          if (response.ok) {
            const order = await readObject(response);
            return order ? { kind: 'found', order } : { kind: 'unavailable' };
          }
          if (response.status === 429)
            return {
              kind: 'rate_limited',
              retryAfterMs: parseRetryAfter(
                response.headers.get('retry-after'),
                now(),
              ),
            };
          if (response.status === 401 || response.status === 403)
            return { kind: 'credentials_rejected' };
          if (response.status === 404) return { kind: 'not_found' };
          const refusal = await readRefusal(response);
          if (refusal === 'key_refused')
            return { kind: 'credentials_rejected' };
          if (refusal) return { kind: refusal };
          return { kind: 'unavailable' };
        },
        { policy: NO_RETRY },
      );
    } catch {
      return { kind: 'unavailable' };
    }
  }

  /**
   * Asks EasyOrders to set one order's status, with the integration's own
   * key. One attempt with a deadline and never a retry here: a repeat could
   * act on an order whose state has moved since. The key and the response
   * bodies never leave this method.
   */
  async updateOrderStatus(
    apiKey: string,
    orderId: string,
    status: string,
    now: () => number = Date.now,
  ): Promise<EasyOrdersStatusUpdate> {
    try {
      return await boundedCall<EasyOrdersStatusUpdate>(
        async () => {
          const response = await this.http(
            `${EASYORDERS_API_BASE}/orders/${encodeURIComponent(orderId)}/status`,
            {
              method: 'PATCH',
              headers: {
                'Api-Key': apiKey,
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ status }),
              redirect: 'error',
              signal: AbortSignal.timeout(STATUS_UPDATE_DEADLINE_MS),
            },
          );
          if (response.ok) return { kind: 'updated' };
          if (response.status >= 500) return { kind: 'ambiguous' };
          if (response.status === 429)
            return {
              kind: 'rate_limited',
              retryAfterMs: parseRetryAfter(
                response.headers.get('retry-after'),
                now(),
              ),
            };
          if (response.status === 401 || response.status === 403)
            return { kind: 'credentials_rejected' };
          if (response.status === 404) return { kind: 'not_found' };
          const refusal = await readRefusal(response);
          if (refusal === 'key_refused')
            return { kind: 'credentials_rejected' };
          if (refusal) return { kind: refusal };
          return { kind: 'rejected' };
        },
        { policy: NO_RETRY },
      );
    } catch {
      return { kind: 'ambiguous' };
    }
  }

  /**
   * Asks EasyOrders to delete the webhook registered for one address, with
   * the integration's own key. The webhooks page documents this call with
   * `Authorization: Bearer` while every other page uses `Api-Key`, and which
   * one is accepted has not been observed (contract record section 6), so a
   * 401 or 403 under `Api-Key` is tried once more as a bearer token.
   *
   * One attempt per header, with a deadline. The key, the address (it holds
   * the URL token) and the response bodies never leave this method.
   */
  async deleteWebhookByUrl(
    apiKey: string,
    webhookUrl: string,
  ): Promise<EasyOrdersWebhookDelete> {
    const attempt = async (
      auth: Record<string, string>,
    ): Promise<EasyOrdersWebhookDelete | 'refused'> => {
      const response = await this.http(
        `${EASYORDERS_API_BASE}/webhooks/delete-by-url?url=${encodeURIComponent(webhookUrl)}`,
        {
          method: 'DELETE',
          headers: { ...auth, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(WEBHOOK_DELETE_DEADLINE_MS),
        },
      );
      if (response.ok) return 'removed';
      if (response.status === 404) return 'not_found';
      if (response.status === 401 || response.status === 403) return 'refused';
      if (response.status === 429 || response.status >= 500)
        return 'unavailable';
      return 'rejected';
    };
    try {
      return await boundedCall<EasyOrdersWebhookDelete>(
        async () => {
          const first = await attempt({ 'Api-Key': apiKey });
          if (first !== 'refused') return first;
          const second = await attempt({ Authorization: `Bearer ${apiKey}` });
          return second === 'refused' ? 'rejected' : second;
        },
        { policy: NO_RETRY },
      );
    } catch {
      return 'unavailable';
    }
  }
}

async function readObject(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Seconds or an HTTP date; null when absent, unreadable or implausible. */
export function parseRetryAfter(
  header: string | null,
  now: number,
): number | null {
  const value = header?.trim();
  if (!value) return null;
  const delayMs = /^\d+$/.test(value)
    ? Number(value) * 1_000
    : Date.parse(value) - now;
  return Number.isFinite(delayMs) &&
    delayMs >= 0 &&
    delayMs <= MAX_RETRY_AFTER_MS
    ? delayMs
    : null;
}

/**
 * Which of the known refusals a 400 is. EasyOrders uses 400 for all of them,
 * so the exact message is the only signal; an unknown one is null.
 */
async function readRefusal(
  response: Response,
): Promise<'store_inactive' | 'not_found' | 'key_refused' | null> {
  if (response.status !== 400) return null;
  try {
    const body = (await response.json()) as { message?: unknown } | null;
    const message = body?.message;
    if (message === EASYORDERS_INACTIVE_STORE_MESSAGE) return 'store_inactive';
    if (message === EASYORDERS_RECORD_NOT_FOUND_MESSAGE) return 'not_found';
    return typeof message === 'string' &&
      EASYORDERS_KEY_REFUSED_MESSAGES.includes(message)
      ? 'key_refused'
      : null;
  } catch {
    return null;
  }
}
