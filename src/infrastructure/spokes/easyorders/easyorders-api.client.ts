import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { boundedCall, NO_RETRY } from '../../../shared/http/bounded-http';

export const EASYORDERS_API_BASE =
  'https://api.easy-orders.net/api/v1/external-apps';

/** The body an inactive store answers every authenticated call with. */
export const EASYORDERS_INACTIVE_STORE_MESSAGE =
  'Store not active or has over due';

const PROBE_DEADLINE_MS = 10_000;
const LOOKUP_DEADLINE_MS = 10_000;
const STATUS_UPDATE_DEADLINE_MS = 10_000;
/** A `Retry-After` longer than this is not believed. */
const MAX_RETRY_AFTER_MS = 10 * 60_000;

export const EASYORDERS_HTTP = Symbol('EASYORDERS_HTTP');
export type EasyOrdersHttp = typeof fetch;

/**
 * - `live`: the key was accepted.
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
 * - `not_found`: this key cannot see such an order.
 * - `store_inactive`: the key is recognized, the store is not active.
 * - `credentials_rejected`: 401 or 403. Permanent until the merchant acts.
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
 * - `credentials_rejected`: 401 or 403. Permanent until the merchant acts.
 * - `store_inactive`: the key is recognized, the store is not active.
 * - `not_found`: this key cannot see such an order.
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

@Injectable()
export class EasyOrdersApiClient {
  constructor(@Inject(EASYORDERS_HTTP) private readonly http: EasyOrdersHttp) {}

  /**
   * Asks EasyOrders whether a key is real, by reading an order that cannot
   * exist. The contract record names no endpoint that identifies a key and
   * the answer to a wrong key is unknown, so this fails closed: only a 2xx or
   * the exact inactive-store 400 counts, and a 404 does not.
   *
   * One attempt, with a deadline. The key and the response body never leave
   * this method.
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
          if (response.status === 400 && (await isInactiveStore(response)))
            return 'store_inactive';
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
          if (response.status === 400 && (await isInactiveStore(response)))
            return { kind: 'store_inactive' };
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
          if (response.status === 400 && (await isInactiveStore(response)))
            return { kind: 'store_inactive' };
          return { kind: 'rejected' };
        },
        { policy: NO_RETRY },
      );
    } catch {
      return { kind: 'ambiguous' };
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

async function isInactiveStore(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { message?: unknown } | null;
    return body?.message === EASYORDERS_INACTIVE_STORE_MESSAGE;
  } catch {
    return false;
  }
}
