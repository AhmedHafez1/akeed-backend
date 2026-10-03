import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { boundedCall, NO_RETRY } from '../../../shared/http/bounded-http';

export const EASYORDERS_API_BASE =
  'https://api.easy-orders.net/api/v1/external-apps';

/** The body an inactive store answers every authenticated call with. */
export const EASYORDERS_INACTIVE_STORE_MESSAGE =
  'Store not active or has over due';

const PROBE_DEADLINE_MS = 10_000;

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
}

async function isInactiveStore(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { message?: unknown } | null;
    return body?.message === EASYORDERS_INACTIVE_STORE_MESSAGE;
  } catch {
    return false;
  }
}
