import { createHmac, randomBytes } from 'node:crypto';
import {
  EASYORDERS_MIGRATIONS,
  easyOrdersConformanceDriver,
  installEasyOrders,
} from './contracts/easyorders-conformance-driver';
import {
  assembleConformanceWorld,
  conformanceBeside,
  createConformanceBase,
  defineSourceConformance,
} from './contracts/source-conformance-harness';
import {
  WOOCOMMERCE_MIGRATIONS,
  installWooCommerce,
  wooCommerceConformanceDriver,
  type WooCommerceDeliveryOverrides,
  type WooCommerceMerchant,
} from './contracts/woocommerce-conformance-driver';
import {
  FAKE_PUBLIC_ADDRESS,
  type FakeWooCommerceStore,
} from './contracts/woocommerce-provider-fake';
import {
  checkoutDraftFixture,
  pingFixture,
  placedNonCodFixture,
} from './fixtures/woocommerce/load';

/**
 * US-07-06 release gate: one WooCommerce store through connect, order, send,
 * customer outcome and store update, over PostgreSQL, with two tenants and a
 * Shopify, a Standalone and an EasyOrders source beside it. Real
 * repositories and services; the edges are fakes: the provider fake under
 * the real restricted outbound client (never a store), the messaging port
 * (never Meta) and the BullMQ queues, whose jobs are recorded and run in
 * process.
 *
 * The matrix is the shared source conformance harness, the one EasyOrders
 * runs. What only WooCommerce decides is in its driver, and the cases only
 * WooCommerce has are below: the signature and source checks, a checkout
 * draft that is placed later, a webhook the store disabled, and the address
 * rules on every path that calls a store.
 */

const base = createConformanceBase({
  namespacePrefix: 'e07_gate',
  messageIdPrefix: 'wamid-e07',
});
const wooCommerce = installWooCommerce(base);
const easyOrders = installEasyOrders(base);
// EasyOrders is bound beside WooCommerce, as the application binds both.
const world = assembleConformanceWorld(base, [
  wooCommerce.spoke,
  easyOrders.spoke,
]);
const woo = wooCommerceConformanceDriver(world, wooCommerce);
const { driver } = woo;
const { fake, auth, contributor, webhooks } = wooCommerce;

const UNAUTHORIZED = { status: 401, code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED' };

const sourceOf = (merchant: WooCommerceMerchant) => ({
  id: merchant.integrationId,
  orgId: merchant.orgId,
});

/** A token of the right shape that Akeed never issued. */
const strangerToken = () => randomBytes(32).toString('base64url');

defineSourceConformance({
  title: 'WooCommerce release gate PostgreSQL contract (US-07-06)',
  world,
  driver,
  migrations: [...EASYORDERS_MIGRATIONS, ...WOOCOMMERCE_MIGRATIONS],
  besides: [
    world.shopifyBeside(),
    world.standaloneBeside(),
    conformanceBeside(
      world,
      easyOrdersConformanceDriver(world, easyOrders).driver,
    ),
  ],
  extraCases: ({ sentOrder, reconcile }) => {
    describe('WooCommerce only: HMAC and source header', () => {
      it('takes a delivery only when the bytes, the signature and the store all agree, and never says which did not', async () => {
        const merchant = await woo.connect();
        const order = woo.placeOrder(merchant);
        const bytes = Buffer.from(
          JSON.stringify(merchant.store.orderBody(order.remoteId)),
          'utf8',
        );
        const signature = woo.signatureOf(bytes, merchant.webhookSecret);
        const changed = Buffer.from(
          bytes.toString('utf8').replace('"450.00"', '"1.00"'),
          'utf8',
        );
        const refusals: [string, Buffer, WooCommerceDeliveryOverrides][] = [
          ['a body changed after it was signed', changed, { signature }],
          ['another secret', bytes, { secret: 'not-the-store-secret' }],
          ['no signature', bytes, { signature: null }],
          ['an empty signature', bytes, { signature: '' }],
          [
            'a signature that is not base64',
            bytes,
            { signature: '!'.repeat(44) },
          ],
          [
            'a truncated signature',
            bytes,
            { signature: signature.slice(0, 20) },
          ],
          [
            'the digest as hex',
            bytes,
            {
              signature: createHmac('sha256', merchant.webhookSecret)
                .update(bytes)
                .digest('hex'),
            },
          ],
          ['no source header', bytes, { source: null }],
          [
            'another store',
            bytes,
            { source: 'https://elsewhere.example.com/' },
          ],
          [
            'the store over plain HTTP',
            bytes,
            { source: `${merchant.store.url.replace('https:', 'http:')}/` },
          ],
          [
            'the store with a path it does not have',
            bytes,
            { source: `${merchant.store.url}/shop/` },
          ],
          ['a source that is not an address', bytes, { source: 'store' }],
        ];
        expect(changed.equals(bytes)).toBe(false);

        const answers: Record<string, unknown> = {};
        for (const [name, body, overrides] of refusals)
          answers[name] = await woo.deliverBytes(
            merchant,
            body,
            'order.created',
            overrides,
          );

        // One answer for every refusal: nothing says which part failed.
        expect(answers).toEqual(
          Object.fromEntries(refusals.map(([name]) => [name, UNAUTHORIZED])),
        );
        expect((await woo.connectionOf(merchant)).rejected_deliveries).toBe(
          refusals.length,
        );
        expect(world.queued).toHaveLength(0);
        expect(await reconcile(merchant)).toMatchObject({
          events: 0,
          orders: 0,
        });

        // The same bytes with the store's own signature and address: taken.
        expect(
          await woo.deliverBytes(merchant, bytes, 'order.created'),
        ).toEqual(driver.accepted);
        await world.drain();
        expect(await reconcile(merchant)).toMatchObject({
          events: 1,
          orders: 1,
          sends: 1,
        });
      });

      it('checks the bytes as they arrived, never a body it serialized again', async () => {
        const merchant = await woo.connect();
        const order = woo.placeOrder(merchant);
        const body = merchant.store.orderBody(order.remoteId);
        // The same order as another serializer would write it: indented, and
        // with a letter escaped.
        const spaced = Buffer.from(
          JSON.stringify(body, null, 3).replace('"Test"', '"\\u0054est"'),
          'utf8',
        );
        const compact = Buffer.from(JSON.stringify(body), 'utf8');
        expect(spaced.equals(compact)).toBe(false);

        // The compact form does not carry the signature of the bytes sent.
        expect(
          await woo.deliverBytes(merchant, compact, 'order.created', {
            signature: woo.signatureOf(spaced, merchant.webhookSecret),
          }),
        ).toEqual(UNAUTHORIZED);
        expect(
          await woo.deliverBytes(merchant, spaced, 'order.created'),
        ).toEqual(driver.accepted);
        await world.drain();

        const [stored] = await world.client<{ customer_name: string }[]>`
          SELECT customer_name FROM orders WHERE integration_id = ${merchant.integrationId}`;
        expect(stored.customer_name).toBe('Test Customer');
      });

      it('accepts the store’s address however the store spells it, for a store at a domain root and in a subdirectory', async () => {
        const root = await woo.connect();
        const nested = await woo.connect(woo.newStore('/shop'));
        const deliver = (merchant: WooCommerceMerchant, source: string) =>
          woo
            .deliverBody(
              merchant,
              merchant.store.orderBody(woo.placeOrder(merchant).remoteId),
              'order.created',
              { source },
            )
            .then((answer) => answer.status);
        const host = (store: FakeWooCommerceStore) => `https://${store.host}`;

        // Finding 2.16: the exact value is not documented. Equal after
        // canonicalization is accepted; anything else is refused.
        expect(
          await Promise.all([
            deliver(root, `${host(root.store)}/`),
            deliver(root, host(root.store)),
            deliver(root, `https://${root.store.host.toUpperCase()}/`),
            deliver(root, `${host(root.store)}:443/`),
            deliver(nested, `${host(nested.store)}/shop/`),
            deliver(nested, `${host(nested.store)}/shop`),
          ]),
        ).toEqual([200, 200, 200, 200, 200, 200]);
        expect(
          await Promise.all([
            // The site's root is not the store in its subdirectory.
            deliver(nested, `${host(nested.store)}/`),
            deliver(nested, `${host(nested.store)}/shop/extra/`),
            deliver(root, `${host(root.store)}/shop/`),
            deliver(root, `${host(root.store)}:8443/`),
            deliver(root, `${host(nested.store)}/`),
          ]),
        ).toEqual([401, 401, 401, 401, 401]);
      });

      it('answers a ping on an address it issued with 200 and stores nothing, with ingestion on or off', async () => {
        const merchant = await woo.connect();
        const ping = (token: string, topic?: string) =>
          world.answer(
            webhooks.handleDelivery(
              token,
              topic ? { topic } : {},
              Buffer.from(pingFixture(), 'utf8'),
            ),
          );

        // Finding 3.10: the ping is not documented, so it is told apart only
        // by what it is not: an order topic.
        expect(await ping(merchant.webhookToken)).toEqual({ status: 200 });
        expect(
          await ping(merchant.webhookToken, 'action.woocommerce_ping'),
        ).toEqual({ status: 200 });
        expect(await ping(strangerToken())).toEqual(UNAUTHORIZED);

        driver.switches.ingestion(false);
        // One non-2xx could count toward disabling the webhook (3.11).
        expect(await ping(merchant.webhookToken)).toEqual({ status: 200 });
        expect(await ping(strangerToken())).toMatchObject({ status: 404 });

        expect(await reconcile(merchant)).toMatchObject({ events: 0 });
        expect((await woo.connectionOf(merchant)).rejected_deliveries).toBe(0);
      });

      it('keeps the same order id from two stores apart, from delivery to the store update', async () => {
        const first = await woo.connect();
        const second = await woo.connect();
        const order = woo.placeOrder(first);
        // Order ids are per store: the other store has an order of this id too.
        second.store.placeOrder({
          ...second.store.orderBody(woo.placeOrder(second).remoteId),
          id: order.remoteId,
          number: String(order.remoteId),
        });
        const twin = { ...order };

        for (const merchant of [first, second])
          expect(
            (
              await woo.deliverBody(
                merchant,
                merchant.store.orderBody(order.remoteId),
                'order.created',
              )
            ).status,
          ).toBe(200);
        await world.drain();
        const sentFirst = await world.sentVerification(
          first.integrationId,
          order.externalOrderId,
        );
        const sentSecond = await world.sentVerification(
          second.integrationId,
          order.externalOrderId,
        );
        expect(sentSecond.verificationId).not.toBe(sentFirst.verificationId);

        await world.reply(sentFirst.verificationId, sentFirst.phone, 'cancel');

        // Only the first store's order was written, with its own key.
        expect(driver.remoteStateOf(first, order)).toBe('cancelled');
        expect(driver.remoteStateOf(second, twin)).toBe('untouched');
        expect(woo.storeRequests(second)).toHaveLength(0);
        expect(await world.verificationStatus(sentSecond.verificationId)).toBe(
          'sent',
        );
      });
    });

    describe('WooCommerce only: draft, then placed', () => {
      it('a checkout draft starts nothing, and the same order once placed is verified exactly once', async () => {
        const merchant = await woo.connect();
        const draft = checkoutDraftFixture().payload;
        // The Checkout block's draft: no payment method yet, and a status
        // whose real value is not documented (finding 4.7).
        const order = woo.placeOrder(merchant, {
          status: draft.status,
          payment_method: draft.payment_method,
          payment_method_title: draft.payment_method_title,
        });
        const held = merchant.store.orders.get(order.remoteId)!;

        expect(
          (
            await woo.deliverBody(
              merchant,
              merchant.store.orderBody(order.remoteId),
              'order.created',
            )
          ).status,
        ).toBe(200);
        expect(await world.drain()).toEqual([{ kind: 'done' }]);
        expect(await world.eventsOf(merchant)).toMatchObject([
          { status: 'skipped', last_error: 'order_not_placed' },
        ]);
        expect(await reconcile(merchant)).toMatchObject({
          orders: 0,
          verifications: 0,
          sends: 0,
          usage: 0,
        });

        // The customer picks cash on delivery and places the order. The
        // store already sent `order.created`, for the draft.
        held.fields.payment_method = 'cod';
        merchant.store.setOrderStatus(order.remoteId, 'processing');
        expect(
          (
            await woo.deliverBody(
              merchant,
              merchant.store.orderBody(order.remoteId),
              'order.updated',
            )
          ).status,
        ).toBe(200);
        // And the same placed order again, on the other topic.
        expect(
          (
            await woo.deliverBody(
              merchant,
              merchant.store.orderBody(order.remoteId),
              'order.created',
            )
          ).status,
        ).toBe(200);
        await world.drain();

        expect(await world.eventsOf(merchant)).toMatchObject([
          { status: 'skipped', last_error: 'order_not_placed' },
          { status: 'completed' },
          { status: 'skipped', last_error: 'remote_status_observed' },
        ]);
        expect(await reconcile(merchant)).toMatchObject({
          events: 3,
          completedEvents: 1,
          orders: 1,
          verifications: 1,
          sends: 1,
          usage: 1,
        });
        const sent = await world.sentVerification(
          merchant.integrationId,
          order.externalOrderId,
        );
        expect(sent.phone).toBe(order.expectedPhone);
        // Nothing was asked of the store to take the order.
        expect(woo.storeRequests(merchant)).toHaveLength(0);
      });

      it('an order paid another way is recorded and never sent, and a held cash-on-delivery order is', async () => {
        const merchant = await woo.connect();
        const bank = placedNonCodFixture().payload;
        const paidByTransfer = woo.placeOrder(merchant, {
          status: bank.status,
          payment_method: bank.payment_method,
          payment_method_title: bank.payment_method_title,
        });
        // Finding 4.12: `on-hold` counts as placed, so a store that holds its
        // cash-on-delivery orders is still verified.
        const heldCod = woo.placeOrder(merchant, { status: 'on-hold' });

        for (const order of [paidByTransfer, heldCod])
          await woo.deliverBody(
            merchant,
            merchant.store.orderBody(order.remoteId),
            'order.created',
          );
        await world.drain();

        expect(await world.eventsOf(merchant)).toMatchObject([
          { status: 'skipped', last_error: 'non_cod_payment_method' },
          { status: 'completed' },
        ]);
        expect(await reconcile(merchant)).toMatchObject({
          orders: 1,
          verifications: 1,
          sends: 1,
          usage: 1,
        });

        const sent = await world.sentVerification(
          merchant.integrationId,
          heldCod.externalOrderId,
        );
        await world.reply(sent.verificationId, sent.phone, 'confirm');

        // Finding 5.16: written from `on-hold`, and the status left as it was.
        expect(merchant.store.orders.get(heldCod.remoteId)).toMatchObject({
          status: 'on-hold',
          notes: [{ customer_note: false }],
        });
        expect(woo.markersOf(merchant, heldCod)).toEqual([
          `customer_confirmation:${sent.verificationId}`,
        ]);
        expect(
          merchant.store.orders.get(paidByTransfer.remoteId),
        ).toMatchObject({ status: bank.status, meta_data: [], notes: [] });
      });
    });

    describe('WooCommerce only: webhook disable and re-enable', () => {
      it('shows a webhook the store disabled, re-enables it only while ingestion is on, and takes the next order', async () => {
        const merchant = await woo.connect();
        const { store } = merchant;
        const [created] = [...store.webhooks.values()];
        // The store disables a webhook after failed deliveries (finding 3.11).
        store.setWebhookStatus(created.id, 'disabled');
        // An order placed meanwhile is never delivered, and never imported.
        woo.placeOrder(merchant);

        // Nothing polls the store: Akeed learns of it when health is read.
        expect(
          (await contributor.describe(sourceOf(merchant)))?.blockedReasons,
        ).toEqual([]);
        expect(
          await contributor.inspectWebhooks(sourceOf(merchant)),
        ).toMatchObject({
          items: [
            { kind: 'order_created', state: 'disabled' },
            { kind: 'order_updated', state: 'active' },
          ],
        });
        expect(
          (await contributor.describe(sourceOf(merchant)))?.blockedReasons,
        ).toEqual(['webhook_disabled']);

        // With ingestion off a re-enabled webhook would get a 404 for its
        // next order and be disabled again (findings 3.11 and 3.17).
        driver.switches.ingestion(false);
        const requestsBefore = fake.requestsTo(store).length;
        expect(await world.answer(auth.enableWebhooks(merchant.owner))).toEqual(
          { status: 503, code: 'WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE' },
        );
        expect(fake.requestsTo(store)).toHaveLength(requestsBefore);
        expect(store.webhooks.get(created.id)?.status).toBe('disabled');

        driver.switches.ingestion(true);
        woo.pings.get(store)!.length = 0;
        const enabled = await world.answer(auth.enableWebhooks(merchant.owner));

        expect(enabled).toMatchObject({
          status: 200,
          body: {
            connection: {
              webhooks: [
                { kind: 'order_created', state: 'active' },
                { kind: 'order_updated', state: 'active' },
              ],
            },
          },
        });
        expect(store.webhooks.get(created.id)?.status).toBe('active');
        // The ping a re-enabled webhook sends is answered 2xx.
        expect(woo.pings.get(store)).toEqual([200]);
        expect(
          (await contributor.describe(sourceOf(merchant)))?.blockedReasons,
        ).toEqual([]);
        // The same two webhooks: nothing was created or replaced.
        expect(store.everCreated).toHaveLength(2);

        const order = await sentOrder(merchant);
        await world.reply(order.verificationId, order.phone, 'confirm');
        expect(driver.remoteStateOf(merchant, order.order)).toBe('confirmed');
        // The order placed while the webhook was disabled was never imported.
        expect(await reconcile(merchant)).toMatchObject({
          orders: 1,
          verifications: 1,
          sends: 1,
        });
      });

      it('leaves a webhook the merchant paused as it is, and sends one deleted at the store to a reconnect', async () => {
        const merchant = await woo.connect();
        const { store } = merchant;
        const [created, updated] = [...store.webhooks.values()];
        store.setWebhookStatus(updated.id, 'paused');

        expect(
          await contributor.inspectWebhooks(sourceOf(merchant)),
        ).toMatchObject({
          items: [
            { kind: 'order_created', state: 'active' },
            { kind: 'order_updated', state: 'paused' },
          ],
        });
        // Paused is the merchant's own choice: shown, and never overridden.
        expect(
          (await contributor.describe(sourceOf(merchant)))?.blockedReasons,
        ).toEqual([]);
        expect(
          (await world.answer(auth.enableWebhooks(merchant.owner))).status,
        ).toBe(200);
        expect(store.webhooks.get(updated.id)?.status).toBe('paused');
        expect(
          fake
            .requestsTo(store)
            .filter((request) => request.route === 'webhook_write'),
        ).toHaveLength(0);

        store.removeWebhook(created.id);
        expect(await world.answer(auth.enableWebhooks(merchant.owner))).toEqual(
          { status: 409, code: 'WOOCOMMERCE_WEBHOOK_MISSING' },
        );
        expect(
          await world.answer(auth.checkConnection(merchant.owner)),
        ).toMatchObject({
          status: 200,
          body: {
            problems: [
              'WOOCOMMERCE_WEBHOOK_MISSING',
              'WOOCOMMERCE_WEBHOOK_PAUSED',
            ],
          },
        });
      });
    });

    describe('WooCommerce only: SSRF on every outbound path', () => {
      /**
       * Every path on which Akeed calls a store. Each is prepared against a
       * store that behaves; the store's address then turns hostile, and the
       * path is run.
       */
      interface OutboundPath {
        prepare: () => Promise<{
          store: FakeWooCommerceStore;
          /** Runs the path and says how it ended. */
          act: () => Promise<string>;
        }>;
        /** How it must end, by what the address did. */
        expected: { address: string; redirect: string };
      }

      const code = (answer: { status: number; code?: string }) =>
        `${answer.status} ${answer.code ?? ''}`.trim();

      const paths: Record<string, OutboundPath> = {
        'the start probe': {
          async prepare() {
            const owner = await world.newOrganization();
            const store = woo.newStore();
            return {
              store,
              act: async () =>
                code(
                  await world.answer(
                    auth.startInstall(owner, {
                      storeUrl: store.url,
                      locale: 'ar',
                    }),
                  ),
                ),
            };
          },
          expected: {
            address: '422 WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC',
            redirect: '422 WOOCOMMERCE_STORE_REDIRECTS',
          },
        },
        'the install callback': {
          async prepare() {
            const owner = await world.newOrganization();
            const install = await woo.beginInstall(owner);
            return {
              store: install.store,
              act: async () => {
                const refusal = code(
                  await world.answer(woo.finishInstall(install)),
                );
                const stored = await world.client`
                  SELECT id FROM integrations WHERE org_id = ${owner.orgId}`;
                return `${refusal}, ${stored.length} stored`;
              },
            };
          },
          expected: {
            address: '422 WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC, 0 stored',
            redirect: '422 WOOCOMMERCE_STORE_REDIRECTS, 0 stored',
          },
        },
        'the health read': {
          async prepare() {
            const merchant = await woo.connect();
            return {
              store: merchant.store,
              act: async () => {
                const read = await contributor.inspectWebhooks(
                  sourceOf(merchant),
                );
                const states = read?.items.map((item) => item.state).join(',');
                // An address that cannot be called says nothing of the keys.
                return `${states}, health ${await driver.healthOf(merchant)}`;
              },
            };
          },
          expected: {
            address: 'unknown,unknown, health ok',
            redirect: 'unknown,unknown, health ok',
          },
        },
        'the connection check': {
          async prepare() {
            const merchant = await woo.connect();
            return {
              store: merchant.store,
              act: async () => {
                const checked = await world.answer(
                  auth.checkConnection(merchant.owner),
                );
                const { problems } = checked.body as { problems: string[] };
                return `${checked.status} ${problems.join(',')}`;
              },
            };
          },
          expected: {
            address: '200 WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC',
            redirect: '200 WOOCOMMERCE_STORE_REDIRECTS',
          },
        },
        'the webhook re-enable': {
          async prepare() {
            const merchant = await woo.connect();
            const [created] = [...merchant.store.webhooks.values()];
            merchant.store.setWebhookStatus(created.id, 'disabled');
            return {
              store: merchant.store,
              act: async () => {
                const refusal = code(
                  await world.answer(auth.enableWebhooks(merchant.owner)),
                );
                return `${refusal}, webhook ${merchant.store.webhooks.get(created.id)?.status}`;
              },
            };
          },
          expected: {
            address:
              '422 WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC, webhook disabled',
            redirect: '422 WOOCOMMERCE_STORE_REDIRECTS, webhook disabled',
          },
        },
        'the outcome write': {
          async prepare() {
            const merchant = await woo.connect();
            const order = await sentOrder(merchant);
            return {
              store: merchant.store,
              act: async () => {
                await world.reply(order.verificationId, order.phone, 'cancel');
                const [sync] = await world.syncsOf(
                  merchant,
                  order.verificationId,
                );
                // The customer's answer is kept; the store is not written.
                return [
                  await world.verificationStatus(order.verificationId),
                  sync.state,
                  sync.error_code,
                  sync.requires_assistance ? 'needs the merchant' : 'retries',
                  `store order ${merchant.store.orders.get(order.order.remoteId)?.status}`,
                ].join(', ');
              },
            };
          },
          expected: {
            address:
              'canceled, failed, store_unreachable, needs the merchant, store order processing',
            redirect:
              'canceled, failed, store_unreachable, needs the merchant, store order processing',
          },
        },
        'the disconnect cleanup': {
          async prepare() {
            const merchant = await woo.connect();
            return {
              store: merchant.store,
              act: async () => {
                const answered = await world.answer(
                  auth.disconnect(merchant.owner),
                );
                const body = answered.body as {
                  state: string;
                  webhookCleanup: string;
                };
                // The disconnect itself never depends on the store.
                return `${body.state}, cleanup ${body.webhookCleanup}`;
              },
            };
          },
          expected: {
            address: 'disconnected, cleanup failed',
            redirect: 'disconnected, cleanup failed',
          },
        },
      };

      const hostile: [
        string,
        'address' | 'redirect',
        (store: FakeWooCommerceStore) => void,
      ][] = [
        ['a private address', 'address', (s) => (s.addresses = ['10.0.0.8'])],
        [
          'the loopback address',
          'address',
          (s) => (s.addresses = ['127.0.0.1']),
        ],
        [
          'the cloud metadata address',
          'address',
          (s) => (s.addresses = ['169.254.169.254']),
        ],
        [
          'a carrier-grade NAT address',
          'address',
          (s) => (s.addresses = ['100.64.0.1']),
        ],
        [
          'the IPv6 loopback address',
          'address',
          (s) => (s.addresses = ['::1']),
        ],
        [
          'an IPv4-mapped private address',
          'address',
          (s) => (s.addresses = ['::ffff:10.0.0.8']),
        ],
        [
          'a public address beside a private one',
          'address',
          (s) => (s.addresses = [FAKE_PUBLIC_ADDRESS, '192.168.1.10']),
        ],
        [
          'a redirect to a private address',
          'redirect',
          (s) => (s.redirectTo = 'https://169.254.169.254/latest/meta-data/'),
        ],
        [
          'a redirect to another public site',
          'redirect',
          (s) => (s.redirectTo = 'https://elsewhere.example.org/wp-json/wc/v3'),
        ],
      ];

      describe.each(Object.entries(paths))('%s', (_name, path) => {
        it.each(hostile)(
          'sends nothing anywhere else when the store’s name resolves to, or the store answers with, %s',
          async (_condition, kind, turnHostile) => {
            const { store, act } = await path.prepare();
            turnHostile(store);
            const requestsBefore = fake.requestsTo(store).length;

            const ended = await act();

            expect(ended).toBe(path.expected[kind]);
            const made = fake.requestsTo(store).slice(requestsBefore);
            if (kind === 'address') {
              // Refused before a connection is opened: the fake transport,
              // which stands where the socket would be, was never reached.
              expect(made).toHaveLength(0);
            } else {
              // The store answered with a redirect, and it was not followed.
              expect(made.length).toBeGreaterThan(0);
              expect(made.map((request) => request.answered)).toEqual(
                made.map(() => 301),
              );
            }
            // Whatever was sent in this case went to a checked public address
            // of a store Akeed was given, and nowhere else.
            expect(
              fake.requests.filter(
                (request) => request.address !== FAKE_PUBLIC_ADDRESS,
              ),
            ).toHaveLength(0);
            expect(
              fake.requests.filter(
                (request) => !request.host.endsWith('.example.com'),
              ),
            ).toHaveLength(0);
          },
        );
      });
    });
  },
});
