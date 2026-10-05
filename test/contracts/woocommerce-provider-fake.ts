import { randomBytes } from 'node:crypto';
import type {
  PinnedTarget,
  PinnedTransport,
  RestrictedHttpResponse,
  RestrictedLookup,
} from '../../src/shared/http/restricted-http';

/**
 * In-process WooCommerce stores for the E07 contract suites. No request
 * leaves the process, and no key a store issues is a real one.
 *
 * The fake sits under the real restricted outbound client, as its DNS and its
 * transport, so every store call in a suite runs the production address
 * checks. Its behavior comes only from the US-07-01 contract record. Where
 * the record says UNKNOWN the fake takes the record's worst-case rule and
 * says which:
 *
 * - A wrong key answers 401 and a key whose user may not manage WooCommerce
 *   answers 403 (findings 2.6 and 2.8: the real answers are UNKNOWN; 401 is
 *   "credentials rejected" and 403 is "permission denied").
 * - The unauthenticated index answers 200 with a small JSON object. What it
 *   really returns is not documented; the connect flow reads only its status.
 * - Saving an active webhook pings its delivery URL at once, with no topic
 *   header (findings 3.9 and 3.10: the ping's headers and body are UNKNOWN).
 * - `secret` is write-only: no response ever carries it (finding 2.10).
 * - A `meta_data` entry sent without an id is added even when its key is
 *   already there (finding 5.3: UNKNOWN; a second entry is the worst case for
 *   a repeated write).
 * - Any status is accepted on an order update (finding 5.11: which
 *   transitions the store allows is UNKNOWN), and every note is stored
 *   (finding 5.6: nothing prevents the same note twice).
 * - An order update sends no delivery by itself (finding 5.12: UNKNOWN). A
 *   suite delivers `orderBody` as `order.updated`, which is the worst case.
 * - Setting a webhook back to `active` pings its delivery URL again (finding
 *   3.17: whether it does is UNKNOWN; a ping is the case Akeed must answer).
 *   A suite disables a webhook with `setWebhookStatus`: the fake does not
 *   count failed deliveries, because the real threshold is the store's own.
 */

/** A public address for the fake DNS; nothing is ever sent to it. */
export const FAKE_PUBLIC_ADDRESS = '93.184.216.34';

export type FakeWooCommerceRoute =
  | 'index'
  | 'system_status'
  | 'list'
  | 'create'
  | 'delete'
  | 'webhook_read'
  | 'webhook_write'
  | 'order_read'
  | 'order_write'
  | 'note_create';

export interface FakeWooCommerceOrder {
  id: number;
  status: string;
  meta_data: { id: number; key: string; value: unknown }[];
  notes: { note: string; customer_note: boolean }[];
  date_modified_gmt: string;
  /** The rest of the order as the store holds it. */
  fields: Record<string, unknown>;
}

/**
 * An exchange that ends without an answer. `before`: the store never took
 * the request. `after`: it did, and the answer was lost. `timeout` leaves the
 * request hanging until the caller's deadline; `reset` breaks the connection.
 */
export interface FakeWooCommerceLoss {
  when: 'before' | 'after';
  how: 'timeout' | 'reset';
}

export interface FakeWooCommerceWebhook {
  id: number;
  name: string;
  status: string;
  topic: string;
  delivery_url: string;
  secret: string;
}

export interface FakeWooCommerceRequest {
  host: string;
  /** The address the request was actually sent to. */
  address: string;
  method: string;
  route: FakeWooCommerceRoute | 'unknown';
  authenticated: boolean;
  /** The HTTP status answered, or `error` when the exchange failed. */
  answered: number | 'error';
  /** The JSON body of an order update or a note, as the store received it. */
  body?: unknown;
}

interface ScriptedFault {
  route: FakeWooCommerceRoute;
  /** Matching requests to let through first. */
  skip: number;
  status: number;
  headers: Record<string, string>;
}

interface ScriptedLoss extends FakeWooCommerceLoss {
  route: FakeWooCommerceRoute;
  skip: number;
}

interface FakeWooCommerceAnswer {
  route: FakeWooCommerceRequest['route'];
  authenticated: boolean;
  response: RestrictedHttpResponse;
  /** Set when the exchange ends without the answer reaching the caller. */
  lose?: FakeWooCommerceLoss['how'];
}

interface IssuedKey {
  consumerSecret: string;
  canManage: boolean;
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): RestrictedHttpResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(body)),
});

const restError = (
  status: number,
  code: string,
  headers: Record<string, string> = {},
) => json(status, { code, message: 'Refused.', data: { status } }, headers);

function parseBody(body: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class FakeWooCommerceStore {
  /** What the fake DNS answers for the host. */
  addresses: string[] = [FAKE_PUBLIC_ADDRESS];
  /** What `environment.home_url` reports; the store's own address by default. */
  homeUrl: string;
  version: string | null = '9.8.1';
  /** False is "Plain" permalinks: `wp-json` does not answer. */
  permalinks = true;
  validCertificate = true;
  /** Every request is answered with a redirect to this address. */
  redirectTo: string | null = null;
  /** No answer at all. */
  down = false;
  /** Widens race windows: every exchange waits this long first. */
  latencyMs = 0;
  /** The store answers 200 to a webhook change and does not make it. */
  ignoreWebhookStatusChange = false;
  /** Called when an active webhook is saved, as the store's ping. */
  onPing: ((deliveryUrl: string) => Promise<void> | void) | null = null;

  readonly host: string;
  readonly webhooks = new Map<number, FakeWooCommerceWebhook>();
  /** Every webhook ever created, including ones deleted since. */
  readonly everCreated: FakeWooCommerceWebhook[] = [];
  readonly orders = new Map<number, FakeWooCommerceOrder>();
  /** What an order's own link is built from; the store's address by default. */
  orderLinkBase: string;
  /** The `id` an order answers with instead of its own, when set. */
  answerOrderIdAs: number | null = null;
  private readonly basePath: string;
  private readonly keys = new Map<string, IssuedKey>();
  private readonly faults: ScriptedFault[] = [];
  private readonly losses: ScriptedLoss[] = [];
  private nextWebhookId = 100;
  private nextMetaId = 5000;
  private modifications = 0;

  constructor(readonly url: string) {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.basePath = parsed.pathname.replace(/\/+$/, '');
    this.homeUrl = url;
    this.orderLinkBase = url;
  }

  /** An order a customer placed in the store. */
  placeOrder(order: Record<string, unknown> & { id: number }): void {
    // What the store keeps itself: a placed order starts with no Akeed meta.
    const owned = new Set(['id', 'status', 'meta_data', '_links']);
    const fields = Object.fromEntries(
      Object.entries(order).filter(([field]) => !owned.has(field)),
    );
    this.orders.set(order.id, {
      id: order.id,
      status: typeof order.status === 'string' ? order.status : 'processing',
      meta_data: [],
      notes: [],
      date_modified_gmt:
        typeof fields.date_modified_gmt === 'string'
          ? fields.date_modified_gmt
          : '2026-01-01T10:00:00',
      fields,
    });
  }

  /** The merchant changes the order in the store's own admin. */
  setOrderStatus(id: number, status: string): void {
    const order = this.orders.get(id);
    if (!order) throw new Error(`fake store has no order ${id}`);
    order.status = status;
    this.touch(order);
  }

  /**
   * The order as the REST API returns it, which is also what an
   * `order.created` or `order.updated` delivery carries (finding 3.3).
   */
  orderBody(id: number): Record<string, unknown> {
    const order = this.orders.get(id);
    if (!order) throw new Error(`fake store has no order ${id}`);
    const base = `${this.orderLinkBase}/wp-json/wc/v3/orders`;
    return {
      ...order.fields,
      id: this.answerOrderIdAs ?? order.id,
      status: order.status,
      date_modified_gmt: order.date_modified_gmt,
      meta_data: order.meta_data.map((entry) => ({ ...entry })),
      _links: {
        self: [{ href: `${base}/${order.id}` }],
        collection: [{ href: base }],
      },
    };
  }

  /** The next matching exchange (after `skip` of them) ends unanswered. */
  loseNext(
    route: FakeWooCommerceRoute,
    loss: FakeWooCommerceLoss,
    skip = 0,
  ): void {
    this.losses.push({ route, skip, ...loss });
  }

  private touch(order: FakeWooCommerceOrder): void {
    this.modifications += 1;
    order.date_modified_gmt = new Date(
      Date.UTC(2026, 0, 2) + this.modifications * 1000,
    )
      .toISOString()
      .slice(0, 19);
  }

  /** The merchant approves on the authorize page: the store issues keys. */
  issueKeys(options: { canManage?: boolean } = {}): {
    consumerKey: string;
    consumerSecret: string;
  } {
    const consumerKey = `ck_${randomBytes(20).toString('hex')}`;
    const consumerSecret = `cs_${randomBytes(20).toString('hex')}`;
    this.keys.set(consumerKey, {
      consumerSecret,
      canManage: options.canManage ?? true,
    });
    return { consumerKey, consumerSecret };
  }

  revokeKey(consumerKey: string): void {
    this.keys.delete(consumerKey);
  }

  /** The key's WordPress user gains or loses the right to manage WooCommerce. */
  setKeyCanManage(consumerKey: string, canManage: boolean): void {
    const issued = this.keys.get(consumerKey);
    if (!issued) throw new Error('fake store has no such key');
    issued.canManage = canManage;
  }

  /** The next matching request (after `skip` of them) answers `status`. */
  failNext(
    route: FakeWooCommerceRoute,
    status: number,
    skip = 0,
    headers: Record<string, string> = {},
  ): void {
    this.faults.push({ route, status, skip, headers });
  }

  /** The store disables a webhook, or the merchant pauses or re-enables it. */
  setWebhookStatus(id: number, status: string): void {
    const webhook = this.webhooks.get(id);
    if (!webhook) throw new Error(`fake store has no webhook ${id}`);
    webhook.status = status;
  }

  /** The merchant deletes a webhook in the store's own admin. */
  removeWebhook(id: number): void {
    if (!this.webhooks.delete(id))
      throw new Error(`fake store has no webhook ${id}`);
  }

  /** A webhook somebody else created in the store. */
  addForeignWebhook(deliveryUrl: string): number {
    return this.save({
      name: 'Another app',
      topic: 'order.created',
      delivery_url: deliveryUrl,
      secret: 'not-akeed',
      status: 'active',
    }).id;
  }

  async answer(target: PinnedTarget): Promise<FakeWooCommerceAnswer> {
    const url = new URL(`https://${this.host}${target.path}`);
    const restBase = `${this.basePath}/wp-json/wc/v3`;
    const authenticated = this.authenticate(target.headers.Authorization);
    const none = { route: 'unknown' as const, authenticated: false };

    if (this.redirectTo)
      return {
        ...none,
        response: {
          status: 301,
          headers: { location: this.redirectTo },
          body: Buffer.alloc(0),
        },
      };
    if (!this.permalinks || !url.pathname.startsWith(restBase))
      return { ...none, response: restError(404, 'rest_no_route') };

    const rest = url.pathname.slice(restBase.length);
    const route = this.routeOf(target.method, rest);
    if (!route) return { ...none, response: restError(404, 'rest_no_route') };

    const fault = this.faults.find((candidate) => candidate.route === route);
    if (fault) {
      if (fault.skip > 0) fault.skip -= 1;
      else {
        this.faults.splice(this.faults.indexOf(fault), 1);
        return {
          route,
          authenticated: authenticated === 'ok',
          response: restError(fault.status, 'injected', fault.headers),
        };
      }
    }

    let lose: FakeWooCommerceLoss['how'] | undefined;
    const loss = this.losses.find((candidate) => candidate.route === route);
    if (loss) {
      if (loss.skip > 0) loss.skip -= 1;
      else {
        this.losses.splice(this.losses.indexOf(loss), 1);
        if (loss.when === 'before')
          return {
            route,
            authenticated: authenticated === 'ok',
            response: restError(0, 'lost'),
            lose: loss.how,
          };
        lose = loss.how;
      }
    }

    if (route === 'index')
      return {
        route,
        authenticated: false,
        response: json(200, { namespace: 'wc/v3' }),
      };
    if (authenticated === 'unknown')
      return {
        route,
        authenticated: false,
        response: restError(401, 'woocommerce_rest_cannot_view'),
      };
    if (authenticated === 'forbidden')
      return {
        route,
        authenticated: false,
        response: restError(403, 'woocommerce_rest_cannot_view'),
      };

    return {
      route,
      authenticated: true,
      response: await this.serve(route, target, url, rest),
      lose,
    };
  }

  private routeOf(
    method: string,
    rest: string,
  ): FakeWooCommerceRoute | undefined {
    if (method === 'GET' && rest === '') return 'index';
    if (method === 'GET' && rest === '/system_status') return 'system_status';
    if (method === 'GET' && rest === '/webhooks') return 'list';
    if (method === 'POST' && rest === '/webhooks') return 'create';
    if (method === 'DELETE' && /^\/webhooks\/\d+$/.test(rest)) return 'delete';
    if (method === 'GET' && /^\/webhooks\/\d+$/.test(rest))
      return 'webhook_read';
    if (method === 'PUT' && /^\/webhooks\/\d+$/.test(rest))
      return 'webhook_write';
    if (method === 'GET' && /^\/orders\/\d+$/.test(rest)) return 'order_read';
    if (method === 'PUT' && /^\/orders\/\d+$/.test(rest)) return 'order_write';
    if (method === 'POST' && /^\/orders\/\d+\/notes$/.test(rest))
      return 'note_create';
    return undefined;
  }

  private authenticate(
    authorization: string | undefined,
  ): 'ok' | 'forbidden' | 'unknown' {
    const encoded = /^Basic (.+)$/.exec(authorization ?? '')?.[1];
    if (!encoded) return 'unknown';
    const [consumerKey, consumerSecret] = Buffer.from(encoded, 'base64')
      .toString('utf8')
      .split(':');
    const issued = this.keys.get(consumerKey);
    if (!issued || issued.consumerSecret !== consumerSecret) return 'unknown';
    return issued.canManage ? 'ok' : 'forbidden';
  }

  private async serve(
    route: Exclude<FakeWooCommerceRoute, 'index'>,
    target: PinnedTarget,
    url: URL,
    rest: string,
  ): Promise<RestrictedHttpResponse> {
    switch (route) {
      case 'system_status':
        return json(200, {
          environment: {
            home_url: this.homeUrl,
            site_url: this.homeUrl,
            version: this.version,
          },
          settings: { currency: 'EGP' },
        });
      case 'list': {
        const perPage = Number(url.searchParams.get('per_page') ?? 10);
        const page = Number(url.searchParams.get('page') ?? 1);
        const all = [...this.webhooks.values()];
        return json(
          200,
          all.slice((page - 1) * perPage, page * perPage).map(publicFields),
          {
            'x-wp-total': String(all.length),
            'x-wp-totalpages': String(
              Math.max(1, Math.ceil(all.length / perPage)),
            ),
          },
        );
      }
      case 'create': {
        const input = JSON.parse(target.body ?? '{}') as Omit<
          FakeWooCommerceWebhook,
          'id'
        >;
        const webhook = this.save(input);
        if (webhook.status === 'active')
          await this.onPing?.(webhook.delivery_url);
        return json(201, publicFields(webhook));
      }
      case 'delete': {
        const id = Number(rest.split('/').pop());
        const webhook = this.webhooks.get(id);
        if (!webhook) return restError(404, 'woocommerce_rest_invalid_id');
        this.webhooks.delete(id);
        return json(200, publicFields(webhook));
      }
      case 'webhook_read': {
        const webhook = this.webhooks.get(Number(rest.split('/').pop()));
        return webhook
          ? json(200, publicFields(webhook))
          : restError(404, 'woocommerce_rest_invalid_id');
      }
      case 'webhook_write': {
        const webhook = this.webhooks.get(Number(rest.split('/').pop()));
        if (!webhook) return restError(404, 'woocommerce_rest_invalid_id');
        const input = parseBody(target.body);
        if (typeof input.status === 'string') {
          const activated =
            input.status === 'active' && webhook.status !== 'active';
          if (!this.ignoreWebhookStatusChange) webhook.status = input.status;
          if (activated && webhook.status === 'active')
            await this.onPing?.(webhook.delivery_url);
        }
        return json(200, publicFields(webhook));
      }
      case 'order_read': {
        const id = Number(rest.split('/').pop());
        return this.orders.has(id)
          ? json(200, this.orderBody(id))
          : restError(404, 'woocommerce_rest_shop_order_invalid_id');
      }
      case 'order_write': {
        const id = Number(rest.split('/').pop());
        const order = this.orders.get(id);
        if (!order)
          return restError(404, 'woocommerce_rest_shop_order_invalid_id');
        const input = parseBody(target.body);
        if (typeof input.status === 'string') order.status = input.status;
        if (Array.isArray(input.meta_data))
          for (const entry of input.meta_data as {
            key?: unknown;
            value?: unknown;
          }[])
            if (typeof entry?.key === 'string')
              order.meta_data.push({
                id: this.nextMetaId++,
                key: entry.key,
                value: entry.value,
              });
        this.touch(order);
        return json(200, this.orderBody(id));
      }
      case 'note_create': {
        const id = Number(rest.split('/').slice(-2)[0]);
        const order = this.orders.get(id);
        if (!order)
          return restError(404, 'woocommerce_rest_shop_order_invalid_id');
        const input = parseBody(target.body);
        const note = {
          note: typeof input.note === 'string' ? input.note : '',
          customer_note: input.customer_note === true,
        };
        order.notes.push(note);
        return json(201, { id: order.notes.length, ...note });
      }
    }
  }

  private save(
    input: Omit<FakeWooCommerceWebhook, 'id'>,
  ): FakeWooCommerceWebhook {
    const webhook = { ...input, id: this.nextWebhookId++ };
    this.webhooks.set(webhook.id, webhook);
    this.everCreated.push(webhook);
    return webhook;
  }
}

/** `secret` is write-only in the REST API. */
function publicFields(webhook: FakeWooCommerceWebhook) {
  return {
    id: webhook.id,
    name: webhook.name,
    status: webhook.status,
    topic: webhook.topic,
    delivery_url: webhook.delivery_url,
  };
}

export class FakeWooCommerce {
  readonly requests: FakeWooCommerceRequest[] = [];
  /** Names the fake DNS answers without a store behind them. */
  readonly bareHosts = new Map<string, string[]>();
  private readonly stores = new Map<string, FakeWooCommerceStore>();

  /** A store at `https://<generated host><path>`, resolving publicly. */
  addStore(path = ''): FakeWooCommerceStore {
    const host = `shop-${randomBytes(6).toString('hex')}.example.com`;
    const store = new FakeWooCommerceStore(`https://${host}${path}`);
    this.stores.set(host, store);
    return store;
  }

  readonly lookup: RestrictedLookup = (hostname) => {
    const addresses =
      this.stores.get(hostname)?.addresses ?? this.bareHosts.get(hostname);
    if (!addresses) return Promise.reject(new Error('ENOTFOUND'));
    return Promise.resolve(
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );
  };

  readonly transport: PinnedTransport = async (target) => {
    const store = this.stores.get(target.hostname);
    const log = (
      route: FakeWooCommerceRequest['route'],
      authenticated: boolean,
      answered: FakeWooCommerceRequest['answered'],
    ) =>
      this.requests.push({
        host: target.hostname,
        address: target.address,
        method: target.method,
        route,
        authenticated,
        answered,
        ...(route === 'order_write' || route === 'note_create'
          ? { body: parseBody(target.body) }
          : {}),
      });
    const fail = (code: string): never => {
      log('unknown', false, 'error');
      throw Object.assign(new Error('fake transport failure'), { code });
    };

    if (!store || store.down) return fail('ECONNRESET');
    if (store.latencyMs)
      await new Promise((resolve) => setTimeout(resolve, store.latencyMs));
    if (!store.validCertificate) return fail('DEPTH_ZERO_SELF_SIGNED_CERT');

    const { route, authenticated, response, lose } = await store.answer(target);
    if (lose) {
      log(route, authenticated, 'error');
      // Never settles: the restricted client's own deadline ends it.
      if (lose === 'timeout')
        return new Promise<RestrictedHttpResponse>(() => undefined);
      throw Object.assign(new Error('fake transport failure'), {
        code: 'ECONNRESET',
      });
    }
    log(route, authenticated, response.status);
    return response;
  };

  requestsTo(store: FakeWooCommerceStore): FakeWooCommerceRequest[] {
    return this.requests.filter((request) => request.host === store.host);
  }
}
