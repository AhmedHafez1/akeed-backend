import {
  EASYORDERS_MIGRATIONS,
  easyOrdersConformanceDriver,
  installEasyOrders,
} from './contracts/easyorders-conformance-driver';
import {
  assembleConformanceWorld,
  createConformanceBase,
  defineSourceConformance,
  type JobEnd,
} from './contracts/source-conformance-harness';

/**
 * US-06-06 release gate: one EasyOrders store through install, order, send,
 * customer outcome and store status, over PostgreSQL, with two tenants and a
 * Shopify source beside it. Real repositories and services; the edges are
 * fakes: the provider fake (never EasyOrders), the messaging port (never
 * Meta) and the BullMQ queues, whose jobs are recorded and run in process.
 *
 * The matrix every source shares lives in the source conformance harness
 * (US-07-06); what only EasyOrders decides is in its driver. The cases below
 * the matrix are the ones only EasyOrders has: it reads an order back from
 * the provider while it ingests it.
 */

const base = createConformanceBase({
  namespacePrefix: 'e06_gate',
  messageIdPrefix: 'wamid-e06',
});
const easyOrders = installEasyOrders(base);
const world = assembleConformanceWorld(base, [easyOrders.spoke]);
const { driver, connectionOf, storeRequests, deliverPayload } =
  easyOrdersConformanceDriver(world, easyOrders);
const { provider } = easyOrders;

defineSourceConformance({
  title: 'EasyOrders release gate PostgreSQL contract (US-06-06)',
  world,
  driver,
  migrations: EASYORDERS_MIGRATIONS,
  besides: [world.shopifyBeside()],
  extraCases: ({ reconcile }) => {
    describe('AC3 key revocation', () => {
      it('a revoked key on an order lookup is permanent: the event is closed and the connection flagged', async () => {
        const merchant = await driver.connect();
        const { payload } = driver.placeOrder(merchant);
        provider.revokeKey(merchant.apiKey);

        await deliverPayload(merchant, { ...payload, full_name: undefined });
        const ends = await world.drain();

        expect(ends).toEqual([{ kind: 'done' }]);
        expect(await world.eventsOf(merchant)).toMatchObject([
          { status: 'skipped', last_error: 'source_credentials_rejected' },
        ]);
        expect((await connectionOf(merchant)).health).toBe(
          'credentials_rejected',
        );
        expect(storeRequests(merchant.apiKey)).toHaveLength(1);
        expect(await reconcile(merchant)).toMatchObject({
          orders: 0,
          sends: 0,
          usage: 0,
        });
      });
    });

    describe('fault injection', () => {
      it('rate limiting on the order lookup: the event is released, not failed, and the order arrives once', async () => {
        const merchant = await driver.connect();
        const { payload } = driver.placeOrder(merchant);
        provider.failNext(
          'read',
          { kind: 'rate_limited', retryAfterSeconds: 1 },
          merchant.apiKey,
        );

        await deliverPayload(merchant, { ...payload, full_name: undefined });
        const [end] = await world.drain();

        expect(end).toMatchObject({ kind: 'delayed' });
        expect(await world.eventsOf(merchant)).toMatchObject([
          { status: 'pending', last_error: 'source_rate_limited' },
        ]);
        await new Promise((done) => setTimeout(done, 1_100));
        const delayed = end as Extract<JobEnd, { kind: 'delayed' }>;
        expect(await world.runJob(delayed.payload)).toEqual({ kind: 'done' });

        expect(await reconcile(merchant)).toMatchObject({
          events: 1,
          completedEvents: 1,
          orders: 1,
          verifications: 1,
          sends: 1,
          usage: 1,
        });
      });
    });
  },
});
