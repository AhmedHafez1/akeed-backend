import { randomBytes } from 'node:crypto';
import {
  EASYORDERS_API_BASE,
  EASYORDERS_INACTIVE_STORE_MESSAGE,
  type EasyOrdersHttp,
} from '../../src/infrastructure/spokes/easyorders/easyorders-api.client';

/**
 * An in-process EasyOrders for the US-06-06 gate. No request leaves the
 * process, and no key it issues is a real one.
 *
 * Its behavior comes only from the US-06-01 contract record. Where the record
 * says UNKNOWN the fake takes the record's worst-case rule and says which:
 *
 * - A wrong or revoked key answers 401 (section 2: the real answer is UNKNOWN;
 *   401 and 403 are to be treated as permanent).
 * - An inactive store answers the documented 400 (section 2, VERIFIED).
 * - A key cannot see another store's order: 404 (section 2: UNKNOWN). The
 *   worst case, a key that can read across stores, is `crossStoreReads`.
 * - A valid key reading an order id nobody has answers 200 with an empty
 *   object. The record names no answer for this; it is what the install
 *   probe needs in order to accept a key, and it is an open question the
 *   live pilot has to settle (US-06-02 open item 1).
 * - Any status may follow any status (section 5: transition rules UNKNOWN).
 * - A 429 carries `Retry-After` only when the fault asks for it (section 8:
 *   headers UNKNOWN).
 */

export type EasyOrdersFault =
  /** 429, not applied. */
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  /** 503, not applied. */
  | { kind: 'unavailable' }
  /** No answer; a write was not taken. */
  | { kind: 'timeout_before_apply' }
  /** No answer; a write was taken. On a read it is a plain timeout. */
  | { kind: 'timeout_after_apply' };

export interface FakeEasyOrdersRequest {
  method: 'GET' | 'PATCH';
  key: string;
  orderId: string;
  /** The status a write asked for. */
  status?: string;
  /** The HTTP status answered, or `timeout` when nothing was. */
  answered: number | 'timeout';
}

interface FakeStore {
  storeId: string;
  active: boolean;
}

interface FakeOrder {
  storeId: string;
  status: string;
  fields: Record<string, unknown>;
}

interface ScriptedFault {
  fault: EasyOrdersFault;
  /** Only requests made with this key take the fault. */
  key?: string;
}

const timeout = (): Promise<Response> =>
  Promise.reject(new DOMException('timed out', 'TimeoutError'));

export function easyOrdersProviderFake() {
  /** Live keys only: a revoked key is removed. */
  const keys = new Map<string, FakeStore>();
  const stores = new Map<string, FakeStore>();
  const orders = new Map<string, FakeOrder>();
  const requests: FakeEasyOrdersRequest[] = [];
  const faults: Record<'read' | 'write', ScriptedFault[]> = {
    read: [],
    write: [],
  };
  const behavior = { crossStoreReads: false };

  function storeOf(storeId: string): FakeStore {
    let store = stores.get(storeId);
    if (!store) {
      store = { storeId, active: true };
      stores.set(storeId, store);
    }
    return store;
  }

  function takeFault(
    channel: 'read' | 'write',
    key: string,
  ): EasyOrdersFault | undefined {
    const index = faults[channel].findIndex(
      (scripted) => scripted.key === undefined || scripted.key === key,
    );
    return index < 0 ? undefined : faults[channel].splice(index, 1)[0].fault;
  }

  const http: EasyOrdersHttp = (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string' ? input : '';
    if (!url.startsWith(`${EASYORDERS_API_BASE}/orders/`))
      throw new Error(`The EasyOrders fake has no route for ${url}`);
    const method = init?.method === 'PATCH' ? 'PATCH' : 'GET';
    const key = new Headers(init?.headers).get('Api-Key') ?? '';
    const segments = url
      .slice(`${EASYORDERS_API_BASE}/orders/`.length)
      .split('/');
    const orderId = decodeURIComponent(segments[0]);
    const requested =
      method === 'PATCH' && typeof init?.body === 'string'
        ? (JSON.parse(init.body) as { status: string }).status
        : undefined;
    const record = (answered: number | 'timeout') =>
      requests.push({ method, key, orderId, status: requested, answered });
    const answer = (status: number, body?: unknown, headers?: HeadersInit) => {
      record(status);
      return Promise.resolve(
        body === undefined
          ? new Response('', { status, headers })
          : Response.json(body, { status, headers }),
      );
    };

    const store = keys.get(key);
    if (!store) return answer(401);
    if (!store.active)
      return answer(400, { message: EASYORDERS_INACTIVE_STORE_MESSAGE });

    const fault = takeFault(method === 'PATCH' ? 'write' : 'read', key);
    if (fault?.kind === 'rate_limited')
      return answer(
        429,
        undefined,
        fault.retryAfterSeconds === undefined
          ? undefined
          : { 'Retry-After': String(fault.retryAfterSeconds) },
      );
    if (fault?.kind === 'unavailable') return answer(503);
    if (fault?.kind === 'timeout_before_apply') {
      record('timeout');
      return timeout();
    }

    const order = orders.get(orderId);
    const visible =
      order && (order.storeId === store.storeId || behavior.crossStoreReads)
        ? order
        : undefined;

    if (method === 'GET') {
      if (fault?.kind === 'timeout_after_apply') {
        record('timeout');
        return timeout();
      }
      if (visible)
        return answer(200, {
          ...visible.fields,
          id: orderId,
          store_id: visible.storeId,
          status: visible.status,
        });
      return order ? answer(404) : answer(200, {});
    }

    if (!visible || visible.storeId !== store.storeId || !requested)
      return answer(404);
    visible.status = requested;
    if (fault?.kind === 'timeout_after_apply') {
      record('timeout');
      return timeout();
    }
    return answer(200, {});
  };

  return {
    http,
    requests,
    behavior,
    /** A new synthetic key for a store, as an install or the dashboard makes. */
    issueKey(storeId: string): string {
      const key = `eo_fake_${randomBytes(24).toString('base64url')}`;
      keys.set(key, storeOf(storeId));
      return key;
    },
    /** The seller deletes the key in the EasyOrders dashboard. */
    revokeKey(key: string): void {
      keys.delete(key);
    },
    setStoreActive(storeId: string, active: boolean): void {
      storeOf(storeId).active = active;
    },
    /** An order in the store, as EasyOrders holds it. */
    placeOrder(
      storeId: string,
      orderId: string,
      fields: Record<string, unknown> = {},
      status = 'pending',
    ): void {
      storeOf(storeId);
      orders.set(orderId, { storeId, status, fields });
    },
    statusOf(orderId: string): string | undefined {
      return orders.get(orderId)?.status;
    },
    /** The seller changes an order in the EasyOrders dashboard. */
    setStatus(orderId: string, status: string): void {
      const order = orders.get(orderId);
      if (!order)
        throw new Error(`The EasyOrders fake has no order ${orderId}`);
      order.status = status;
    },
    /** The next matching request takes the fault; faults queue in order. */
    failNext(
      channel: 'read' | 'write',
      fault: EasyOrdersFault,
      key?: string,
    ): void {
      faults[channel].push({ fault, key });
    },
    writes(key?: string): FakeEasyOrdersRequest[] {
      return requests.filter(
        (request) =>
          request.method === 'PATCH' &&
          (key === undefined || request.key === key),
      );
    },
    requestsWith(key: string): FakeEasyOrdersRequest[] {
      return requests.filter((request) => request.key === key);
    },
    /** Between tests: the request log and unused faults go, the stores stay. */
    clear(): void {
      requests.length = 0;
      faults.read.length = 0;
      faults.write.length = 0;
      behavior.crossStoreReads = false;
    },
  };
}

export type EasyOrdersProviderFake = ReturnType<typeof easyOrdersProviderFake>;
