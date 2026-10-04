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
 */

/** A public address for the fake DNS; nothing is ever sent to it. */
export const FAKE_PUBLIC_ADDRESS = '93.184.216.34';

export type FakeWooCommerceRoute =
  | 'index'
  | 'system_status'
  | 'list'
  | 'create'
  | 'delete';

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
}

interface ScriptedFault {
  route: FakeWooCommerceRoute;
  /** Matching requests to let through first. */
  skip: number;
  status: number;
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

const restError = (status: number, code: string) =>
  json(status, { code, message: 'Refused.', data: { status } });

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
  /** Called when an active webhook is saved, as the store's ping. */
  onPing: ((deliveryUrl: string) => Promise<void> | void) | null = null;

  readonly host: string;
  readonly webhooks = new Map<number, FakeWooCommerceWebhook>();
  /** Every webhook ever created, including ones deleted since. */
  readonly everCreated: FakeWooCommerceWebhook[] = [];
  private readonly basePath: string;
  private readonly keys = new Map<string, IssuedKey>();
  private readonly faults: ScriptedFault[] = [];
  private nextWebhookId = 100;

  constructor(readonly url: string) {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.basePath = parsed.pathname.replace(/\/+$/, '');
    this.homeUrl = url;
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

  /** The next matching request (after `skip` of them) answers `status`. */
  failNext(route: FakeWooCommerceRoute, status: number, skip = 0): void {
    this.faults.push({ route, status, skip });
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

  async answer(target: PinnedTarget): Promise<{
    route: FakeWooCommerceRequest['route'];
    authenticated: boolean;
    response: RestrictedHttpResponse;
  }> {
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
          response: restError(fault.status, 'injected'),
        };
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
      });
    const fail = (code: string): never => {
      log('unknown', false, 'error');
      throw Object.assign(new Error('fake transport failure'), { code });
    };

    if (!store || store.down) return fail('ECONNRESET');
    if (store.latencyMs)
      await new Promise((resolve) => setTimeout(resolve, store.latencyMs));
    if (!store.validCertificate) return fail('DEPTH_ZERO_SELF_SIGNED_CERT');

    const { route, authenticated, response } = await store.answer(target);
    log(route, authenticated, response.status);
    return response;
  };

  requestsTo(store: FakeWooCommerceStore): FakeWooCommerceRequest[] {
    return this.requests.filter((request) => request.host === store.host);
  }
}
