import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { plainToInstance } from 'class-transformer';
import { eq } from 'drizzle-orm';
import { ManualOrderIngestionRepository } from '../src/infrastructure/database/repositories/manual-order-ingestion.repository';
import {
  creditReservations,
  orders,
  verificationMessageDispatches,
  verifications,
  webhookEvents,
} from '../src/infrastructure/database/schema';
import { ApiOrderChannelAdapter } from '../src/modules/order-api/api-order.channel-adapter';
import type { CreateApiOrderDto } from '../src/modules/order-api/dto/create-api-order.dto';
import {
  createApiOrderPipe,
  OrderApiController,
} from '../src/modules/order-api/order-api.controller';
import { FileImportChannelAdapter } from '../src/modules/order-imports/file-import.channel-adapter';
import { IMPORT_FIELDS } from '../src/modules/order-imports/mapping/alias-dictionary';
import { StandaloneOrderIngestionService } from '../src/modules/order-ingestion/standalone-order-ingestion.service';
import { StandaloneSourceResolver } from '../src/modules/order-ingestion/standalone-source-resolver';
import { CreateManualOrderDto } from '../src/modules/orders/dto/create-manual-order.dto';
import { PhoneService } from '../src/shared/services/phone.service';
import {
  releaseGateHarness,
  type ReleaseGateHarness,
} from './contracts/release-gate-harness';

const gate = releaseGateHarness();
type Merchant = Awaited<ReturnType<ReleaseGateHarness['merchant']>>;
type OrderRow = typeof orders.$inferSelect;

const adapter = new ApiOrderChannelAdapter(new PhoneService());
const controller = new OrderApiController(gate.services.ingestion, adapter);

/** The principal `IntegrationApiKeyGuard` attaches for a key of this source. */
function keyOf(merchant: Merchant, prefix = 'ak_live_contract') {
  return {
    orgId: merchant.orgId,
    integrationId: merchant.integrationId,
    keyId: randomUUID(),
    prefix,
  };
}

/** One request as the route handles it: the route pipe, then the controller. */
async function submit(
  merchant: Merchant,
  body: Record<string, unknown>,
  idempotencyKey: string,
  options: {
    principal?: ReturnType<typeof keyOf>;
    via?: OrderApiController;
  } = {},
) {
  const dto = (await createApiOrderPipe.transform(body, {
    type: 'body',
    metatype: Object,
    data: '',
  })) as CreateApiOrderDto;
  return (options.via ?? controller).create(
    options.principal ?? keyOf(merchant),
    idempotencyKey,
    dto,
  );
}

const newKey = () => `order-${randomUUID()}`;

const order = (overrides: Record<string, unknown> = {}) => ({
  externalOrderId: `#${Math.floor(Math.random() * 1e9)}`,
  customerName: 'Mona Ali',
  customerPhone: '+201001234567',
  totalPrice: '450',
  currency: 'EGP',
  paymentMethod: 'cod',
  ...overrides,
});

/**
 * Everything a request could change for an organization, in a stable order.
 * A replay or a conflict must leave it equal, row for row.
 */
async function stateOf(orgId: string) {
  const [orderRows, eventRows, verificationRows, dispatchRows, holdRows] =
    await Promise.all([
      gate.db
        .select()
        .from(orders)
        .where(eq(orders.orgId, orgId))
        .orderBy(orders.id),
      gate.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.orgId, orgId))
        .orderBy(webhookEvents.id),
      gate.db
        .select()
        .from(verifications)
        .where(eq(verifications.orgId, orgId))
        .orderBy(verifications.id),
      gate.db
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.orgId, orgId))
        .orderBy(verificationMessageDispatches.id),
      gate.db
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.orgId, orgId))
        .orderBy(creditReservations.id),
    ]);
  return {
    orders: orderRows,
    events: eventRows,
    verifications: verificationRows,
    dispatches: dispatchRows,
    creditHolds: holdRows,
    sends: gate.sends.length,
    queued: gate.dispatchedIds.length,
  };
}

/** The stable code of a refusal; anything else is rethrown. */
function codeFrom(error: unknown): string {
  const response = (
    error as { getResponse?: () => { code?: string } }
  ).getResponse?.();
  if (response?.code) return response.code;
  throw error;
}

async function codeOf(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    return codeFrom(error);
  }
  throw new Error('expected a refusal');
}

/** Each attempt's answer, or the code it was refused with. */
function settle(attempts: Promise<{ orderId: string; duplicate: boolean }>[]) {
  return Promise.all(
    attempts.map((attempt) =>
      attempt.then(
        (answer) => ({ answer, code: null }),
        (error: unknown) => ({ answer: null, code: codeFrom(error) }),
      ),
    ),
  );
}

const IMPORT_HEADER =
  'Order Number,Customer Name,Phone,Amount,Payment Method,City,Notes';

/** A file import through the real services, up to the held commit. */
async function importHeld(merchant: Merchant, rows: string[]) {
  const bytes = Buffer.from([IMPORT_HEADER, ...rows].join('\r\n'));
  const { batchId } = await gate.services.uploads.upload(
    merchant.user,
    merchant.source,
    {
      buffer: bytes,
      size: bytes.length,
      originalname: `idempotency-${randomUUID()}.csv`,
    },
  );
  const columns: Record<string, unknown> = {
    orderReference: 'Order Number',
    customerName: ['Customer Name'],
    phone: 'Phone',
    amount: 'Amount',
    paymentMethod: 'Payment Method',
    city: 'City',
    notes: 'Notes',
  };
  await gate.services.mapping.save(merchant.user, merchant.source, batchId, {
    mapping: Object.fromEntries(
      IMPORT_FIELDS.map((field) => [field, columns[field] ?? null]),
    ),
    options: {
      country: 'EG',
      defaultCurrency: 'EGP',
      dateFormat: 'auto',
      paymentValueMap: {},
    },
  } as never);
  await gate.services.commits.commit(
    merchant.user,
    merchant.source,
    batchId,
    `commit-${batchId}`,
  );
  for (const job of gate.commitJobs.splice(0))
    await gate.services.commitProcessor.process({ data: job } as Job<{
      batchId: string;
      orgId: string;
    }>);
  return batchId;
}

async function startBatch(merchant: Merchant, batchId: string) {
  const quote = await gate.services.starts.quote(
    merchant.user,
    merchant.source,
    batchId,
  );
  await gate.services.starts.start(
    merchant.user,
    merchant.source,
    batchId,
    `start-${batchId}`,
    { quoteToken: quote.quoteToken },
  );
}

async function releaseBatch(merchant: Merchant, batchId: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await gate.services.ticks.tick(merchant.orgId);
    await gate.drain();
    const [batch] = await gate.client<{ status: string }[]>`
      SELECT status FROM order_import_batches WHERE id = ${batchId}`;
    if (batch.status !== 'releasing') return;
  }
  throw new Error('release did not finish');
}

/** The request an integrator would send for an order Akeed already stores. */
function apiBodyOf(stored: OrderRow, overrides: Record<string, unknown> = {}) {
  const canonical = (stored.rawPayload as { order: Record<string, string> })
    .order;
  const body: Record<string, unknown> = {
    externalOrderId: canonical.orderNumber,
    customerName: canonical.customerName,
    customerPhone: canonical.customerPhone,
    totalPrice: canonical.totalPrice,
    currency: canonical.currency,
    paymentMethod: canonical.paymentMethod,
  };
  for (const extra of ['orderDate', 'city', 'address', 'notes'])
    if (canonical[extra] !== undefined) body[extra] = canonical[extra];
  return { ...body, ...overrides };
}

/**
 * US-05-03 over PostgreSQL: an order Akeed already has is replayed or refused
 * by the ingestion core, whichever key or channel brings it back, and neither
 * answer writes an event, starts a verification, sends a message or holds a
 * credit. Real repositories and services; only the messaging port and the
 * queues are fakes (see `releaseGateHarness`).
 */
describe('order API idempotency PostgreSQL contract (US-05-03)', () => {
  beforeAll(() => gate.setup());
  afterAll(() => gate.teardown());

  describe('the same Idempotency-Key (request identity)', () => {
    it('answers the original identifiers after the order was processed', async () => {
      const merchant = await gate.merchant();
      const key = newKey();
      const body = order({ externalOrderId: 'K-1' });
      const first = await submit(merchant, body, key);
      await gate.drain();
      const before = await stateOf(merchant.orgId);
      expect(before.verifications).toHaveLength(1);

      const replay = await submit(merchant, body, key);
      await gate.drain();

      // The verification did not exist yet when the first answer was sent.
      expect(first).toEqual({
        orderId: first.orderId,
        status: 'accepted',
        duplicate: false,
      });
      expect(replay).toEqual({
        orderId: first.orderId,
        verificationId: before.verifications[0].id,
        status: 'accepted',
        duplicate: true,
      });
      expect(await stateOf(merchant.orgId)).toEqual(before);
    });

    it('recovers a response lost after the dispatch, before and after the job runs', async () => {
      const merchant = await gate.merchant();
      const key = newKey();
      const body = order({ externalOrderId: 'K-2' });
      // The client never sees this answer.
      const lost = await submit(merchant, body, key);

      // The job is queued but has not run yet.
      const early = await submit(merchant, body, key);
      expect(early).toMatchObject({ orderId: lost.orderId, duplicate: true });
      await gate.drain();
      const late = await submit(merchant, body, key);
      expect(late).toMatchObject({ orderId: lost.orderId, duplicate: true });
      await gate.drain();

      const state = await stateOf(merchant.orgId);
      expect(state.orders).toHaveLength(1);
      expect(state.events).toHaveLength(1);
      expect(state.verifications).toHaveLength(1);
      expect(state.dispatches).toHaveLength(1);
      expect(state.creditHolds).toHaveLength(1);
      expect(
        gate.dispatchedIds.filter((id) => id === state.events[0].id),
      ).toHaveLength(1);
    });

    it('re-dispatches the committed event when the first request failed before queueing', async () => {
      const merchant = await gate.merchant();
      const sendsBefore = gate.sends.length;
      let failing = true;
      const flaky = new OrderApiController(
        new StandaloneOrderIngestionService(
          new ManualOrderIngestionRepository(gate.db),
          {
            dispatchById: (eventId: string) =>
              failing
                ? Promise.reject(new Error('queue unavailable'))
                : gate.services.dispatcher.dispatchById(eventId),
            isAlreadyDispatched: (eventId: string) =>
              gate.services.dispatcher.isAlreadyDispatched(eventId),
          } as never,
          gate.repositories.verifications,
          new StandaloneSourceResolver(gate.repositories.integrations),
          gate.services.readiness,
        ),
        adapter,
      );
      const key = newKey();
      const body = order({ externalOrderId: 'K-3' });

      await expect(
        codeOf(submit(merchant, body, key, { via: flaky })),
      ).resolves.toBe('API_ORDER_DISPATCH_FAILED');
      const committed = await stateOf(merchant.orgId);
      expect(committed.orders).toHaveLength(1);
      expect(committed.events).toHaveLength(1);
      expect(committed.verifications).toEqual([]);

      failing = false;
      const retry = await submit(merchant, body, key, { via: flaky });
      await gate.drain();

      expect(retry).toMatchObject({
        orderId: committed.orders[0].id,
        duplicate: true,
      });
      const state = await stateOf(merchant.orgId);
      expect(state.orders).toHaveLength(1);
      expect(state.events).toHaveLength(1);
      expect(state.verifications).toHaveLength(1);
      expect(state.creditHolds).toHaveLength(1);
      expect(gate.sends.length).toBe(sendsBefore + 1);
    });

    it('lets concurrent identical requests create one order and all answer it', async () => {
      const merchant = await gate.merchant();
      const sendsBefore = gate.sends.length;
      const key = newKey();
      const body = order({ externalOrderId: 'K-4' });

      const answers = await Promise.all(
        Array.from({ length: 8 }, () => submit(merchant, body, key)),
      );
      await gate.drain();

      expect(new Set(answers.map((answer) => answer.orderId)).size).toBe(1);
      expect(answers.filter((answer) => !answer.duplicate)).toHaveLength(1);
      const state = await stateOf(merchant.orgId);
      expect(state.orders).toHaveLength(1);
      expect(state.events).toHaveLength(1);
      expect(state.verifications).toHaveLength(1);
      expect(state.dispatches).toHaveLength(1);
      expect(state.creditHolds).toHaveLength(1);
      expect(gate.sends.length).toBe(sendsBefore + 1);
    });

    it('lets concurrent conflicting requests keep one content and refuse the other', async () => {
      const merchant = await gate.merchant();
      const key = newKey();
      const bodies = [
        order({ externalOrderId: 'K-5', totalPrice: '100' }),
        order({ externalOrderId: 'K-5', totalPrice: '200' }),
      ];

      const outcomes = await settle(
        Array.from({ length: 6 }, (_, index) =>
          submit(merchant, bodies[index % 2], key),
        ),
      );
      await gate.drain();

      const state = await stateOf(merchant.orgId);
      expect(state.orders).toHaveLength(1);
      expect(state.events).toHaveLength(1);
      expect(state.verifications).toHaveLength(1);
      expect(state.creditHolds).toHaveLength(1);
      const winner = state.orders[0].totalPrice === '100.00' ? 0 : 1;
      outcomes.forEach((outcome, index) => {
        if (index % 2 === winner)
          expect(outcome.answer).toMatchObject({
            orderId: state.orders[0].id,
          });
        else expect(outcome.code).toBe('API_ORDER_IDEMPOTENCY_CONFLICT');
      });
      expect(
        outcomes.filter((outcome) => outcome.answer?.duplicate === false),
      ).toHaveLength(1);
    });

    it('survives credential rotation: the key belongs to the source, not the credential', async () => {
      const merchant = await gate.merchant();
      const key = newKey();
      const body = order({ externalOrderId: 'K-6' });
      const first = await submit(merchant, body, key, {
        principal: keyOf(merchant, 'ak_live_old00001'),
      });
      await gate.drain();
      const before = await stateOf(merchant.orgId);

      const rotated = keyOf(merchant, 'ak_live_new00002');
      await expect(
        submit(merchant, body, key, { principal: rotated }),
      ).resolves.toMatchObject({ orderId: first.orderId, duplicate: true });
      await expect(
        codeOf(
          submit(merchant, { ...body, totalPrice: '999' }, key, {
            principal: rotated,
          }),
        ),
      ).resolves.toBe('API_ORDER_IDEMPOTENCY_CONFLICT');
      // A new key from the new credential is the same order too.
      await expect(
        submit(merchant, body, newKey(), { principal: rotated }),
      ).resolves.toMatchObject({ orderId: first.orderId, duplicate: true });
      await gate.drain();

      expect(await stateOf(merchant.orgId)).toEqual(before);
    });
  });

  describe('a new Idempotency-Key for an order Akeed already has (order identity)', () => {
    it('replays an identical order without a new event or a second send', async () => {
      const merchant = await gate.merchant();
      const body = order({ externalOrderId: ' #X-1 ', notes: 'Call first' });
      const first = await submit(merchant, body, newKey());
      await gate.drain();
      const before = await stateOf(merchant.orgId);
      expect(before.events).toHaveLength(1);

      // The reference is the same order however it is written.
      const replay = await submit(
        merchant,
        { ...body, externalOrderId: 'x-1', orderNumber: '#X-1' },
        newKey(),
      );
      await gate.drain();

      expect(replay).toEqual({
        orderId: first.orderId,
        verificationId: before.verifications[0].id,
        status: 'accepted',
        duplicate: true,
      });
      expect(await stateOf(merchant.orgId)).toEqual(before);
    });

    it('replays whatever order the JSON keys of the body arrive in', async () => {
      const merchant = await gate.merchant();
      const body = order({
        externalOrderId: 'X-2',
        city: 'Cairo',
        address: '12 Nile St',
        notes: 'Call first',
        orderDate: '2026-10-01',
      });
      const first = await submit(merchant, body, newKey());
      await gate.drain();
      const before = await stateOf(merchant.orgId);

      const reordered = Object.fromEntries(Object.entries(body).reverse());
      expect(Object.keys(reordered)).not.toEqual(Object.keys(body));
      await expect(
        submit(merchant, reordered, newKey()),
      ).resolves.toMatchObject({ orderId: first.orderId, duplicate: true });
      await gate.drain();

      expect(await stateOf(merchant.orgId)).toEqual(before);
    });

    it.each([
      ['the amount', { totalPrice: '451' }],
      ['the customer', { customerName: 'Someone Else' }],
      ['an added extra', { notes: 'Leave at the door' }],
      ['the order number', { orderNumber: 'X-3 (edited)' }],
    ])(
      'refuses the order when %s differs and writes nothing',
      async (_case, change) => {
        const merchant = await gate.merchant();
        const body = order({ externalOrderId: 'X-3' });
        await submit(merchant, body, newKey());
        await gate.drain();
        const before = await stateOf(merchant.orgId);

        await expect(
          codeOf(submit(merchant, { ...body, ...change }, newKey())),
        ).resolves.toBe('API_ORDER_EXTERNAL_ID_CONFLICT');
        await gate.drain();

        expect(await stateOf(merchant.orgId)).toEqual(before);
      },
    );

    it('lets concurrent identical requests under different keys create one order', async () => {
      const merchant = await gate.merchant();
      const sendsBefore = gate.sends.length;
      const body = order({ externalOrderId: 'X-4' });

      const answers = await Promise.all(
        Array.from({ length: 8 }, () => submit(merchant, body, newKey())),
      );
      await gate.drain();

      expect(new Set(answers.map((answer) => answer.orderId)).size).toBe(1);
      expect(answers.filter((answer) => !answer.duplicate)).toHaveLength(1);
      const state = await stateOf(merchant.orgId);
      expect(state.orders).toHaveLength(1);
      // The losers' events were rolled back with their transactions.
      expect(state.events).toHaveLength(1);
      expect(state.events[0].orderId).toBe(state.orders[0].id);
      expect(state.verifications).toHaveLength(1);
      expect(state.dispatches).toHaveLength(1);
      expect(state.creditHolds).toHaveLength(1);
      expect(gate.sends.length).toBe(sendsBefore + 1);
    });

    it('lets concurrent conflicting requests under different keys keep one order and refuse the other', async () => {
      const merchant = await gate.merchant();
      const sendsBefore = gate.sends.length;
      const bodies = [
        order({ externalOrderId: 'X-5', totalPrice: '100' }),
        order({ externalOrderId: 'X-5', totalPrice: '200' }),
      ];

      const outcomes = await settle(
        Array.from({ length: 6 }, (_, index) =>
          submit(merchant, bodies[index % 2], newKey()),
        ),
      );
      await gate.drain();

      const state = await stateOf(merchant.orgId);
      expect(state.orders).toHaveLength(1);
      expect(state.events).toHaveLength(1);
      expect(state.verifications).toHaveLength(1);
      expect(state.creditHolds).toHaveLength(1);
      expect(gate.sends.length).toBe(sendsBefore + 1);
      const winner = state.orders[0].totalPrice === '100.00' ? 0 : 1;
      outcomes.forEach((outcome, index) => {
        if (index % 2 === winner)
          expect(outcome.answer).toMatchObject({
            orderId: state.orders[0].id,
          });
        else expect(outcome.code).toBe('API_ORDER_EXTERNAL_ID_CONFLICT');
      });
      expect(
        outcomes.filter((outcome) => outcome.answer?.duplicate === false),
      ).toHaveLength(1);
    });
  });

  describe('isolation between sources and channels', () => {
    it('never replays or refuses across two integrations', async () => {
      const first = await gate.merchant();
      const second = await gate.merchant();
      const key = newKey();
      // The same key and the same external id, with different content.
      const a = await submit(
        first,
        order({ externalOrderId: 'ISO-1', totalPrice: '100' }),
        key,
      );
      const b = await submit(
        second,
        order({ externalOrderId: 'ISO-1', totalPrice: '200' }),
        key,
      );
      await gate.drain();
      expect(a.duplicate).toBe(false);
      expect(b.duplicate).toBe(false);
      expect(a.orderId).not.toBe(b.orderId);
      const [beforeA, beforeB] = [
        await stateOf(first.orgId),
        await stateOf(second.orgId),
      ];

      // A new key replays each source's own order and knows nothing of the
      // other's: the first source's content is a conflict only in the second.
      await expect(
        submit(
          first,
          order({ externalOrderId: 'ISO-1', totalPrice: '100' }),
          newKey(),
        ),
      ).resolves.toMatchObject({ orderId: a.orderId, duplicate: true });
      await expect(
        codeOf(
          submit(
            second,
            order({ externalOrderId: 'ISO-1', totalPrice: '100' }),
            newKey(),
          ),
        ),
      ).resolves.toBe('API_ORDER_EXTERNAL_ID_CONFLICT');
      await gate.drain();

      expect(await stateOf(first.orgId)).toEqual(beforeA);
      expect(await stateOf(second.orgId)).toEqual(beforeB);
    });

    it('keeps an API key apart from a manual key of the same text', async () => {
      const merchant = await gate.merchant();
      const key = `shared-${randomUUID()}`;
      const manual = await gate.services.orders.createManualOrder(
        merchant.user,
        key,
        plainToInstance(CreateManualOrderDto, {
          customerPhone: '+201001234568',
          customerName: 'Walk In',
          orderNumber: 'M-1',
          totalPrice: '100',
          currency: 'EGP',
          paymentMethod: 'cash_on_delivery',
        }),
      );
      await gate.drain();

      // Different content under the same key text: a new order, not a
      // conflict with the manual submission.
      const body = order({ externalOrderId: 'A-1' });
      const api = await submit(merchant, body, key);
      await gate.drain();
      expect(api.duplicate).toBe(false);
      expect(api.orderId).not.toBe(manual.orderId);

      const before = await stateOf(merchant.orgId);
      expect(before.events.map((event) => event.idempotencyKey).sort()).toEqual(
        [key, `api:${key}`].sort(),
      );
      await expect(submit(merchant, body, key)).resolves.toMatchObject({
        orderId: api.orderId,
        duplicate: true,
      });
      await gate.drain();
      expect(await stateOf(merchant.orgId)).toEqual(before);
    });
  });

  describe('a file import, then the API (cross-channel identity)', () => {
    async function imported(merchant: Merchant) {
      const batchId = await importHeld(merchant, [
        'FI-1,Mona Ali,01001234567,300,COD,Cairo,Call first',
      ]);
      const [stored] = await gate.db
        .select()
        .from(orders)
        .where(eq(orders.orgId, merchant.orgId));
      expect(stored.externalOrderId).toBe('ref:fi-1');
      return { batchId, stored };
    }

    async function holdStateOf(orderId: string) {
      const [event] = await gate.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.orderId, orderId));
      return event.holdState;
    }

    const stages: Array<
      [string, (merchant: Merchant, batchId: string) => Promise<void>, string]
    > = [
      ['held', () => Promise.resolve(), 'held'],
      [
        'released',
        async (merchant, batchId) => {
          await startBatch(merchant, batchId);
          await releaseBatch(merchant, batchId);
        },
        'released',
      ],
      [
        'withdrawn',
        async (merchant, batchId) => {
          await startBatch(merchant, batchId);
          await gate.services.starts.stop(
            merchant.user,
            merchant.source,
            batchId,
          );
        },
        'withdrawn',
      ],
    ];

    it.each(stages)(
      'batch %s: an identical order is a duplicate and the state is untouched',
      async (_stage, advance, holdState) => {
        const merchant = await gate.merchant();
        const { batchId, stored } = await imported(merchant);
        await advance(merchant, batchId);
        expect(await holdStateOf(stored.id)).toBe(holdState);
        const before = await stateOf(merchant.orgId);
        expect(before.verifications).toHaveLength(
          holdState === 'released' ? 1 : 0,
        );

        const answer = await submit(merchant, apiBodyOf(stored), newKey());
        await gate.drain();

        expect(answer).toMatchObject({
          orderId: stored.id,
          status: 'accepted',
          duplicate: true,
        });
        expect(answer.verificationId).toBe(before.verifications[0]?.id);
        // Held stays held and withdrawn stays withdrawn: nothing was written,
        // queued, sent or reserved.
        expect(await stateOf(merchant.orgId)).toEqual(before);
      },
    );

    it.each(stages)(
      'batch %s: differing extras are refused and the state is untouched',
      async (_stage, advance) => {
        const merchant = await gate.merchant();
        const { batchId, stored } = await imported(merchant);
        await advance(merchant, batchId);
        const before = await stateOf(merchant.orgId);

        for (const change of [{ notes: 'Different note' }, { city: undefined }])
          await expect(
            codeOf(submit(merchant, apiBodyOf(stored, change), newKey())),
          ).resolves.toBe('API_ORDER_EXTERNAL_ID_CONFLICT');
        await gate.drain();

        expect(await stateOf(merchant.orgId)).toEqual(before);
      },
    );

    describe('an import-generated IMP-… order number', () => {
      async function heldWithGeneratedNumber(merchant: Merchant) {
        const batch = { id: randomUUID(), shortCode: 'ABC123' };
        const row = FileImportChannelAdapter.toAcceptManyInput(
          {
            rowNumber: 2,
            normalized: {
              customerPhone: '+201001234567',
              customerName: 'Mona Ali',
              totalPrice: '300.00',
              currency: 'EGP',
              paymentMethod: 'cod',
            },
            dedupeKey: 'ref:gen-1',
          },
          batch,
        );
        expect(row.order.orderNumber).toBe('IMP-ABC123-2');
        const accept = () =>
          gate.services.ingestion.acceptMany(
            { orgId: merchant.orgId, source: merchant.source },
            [row],
            { channel: 'bulk_import', hold: { groupId: batch.id } },
          );
        const [accepted] = await accept();
        if (accepted.status !== 'accepted') throw new Error('not accepted');
        return { orderId: accepted.orderId, row, accept };
      }

      it('is part of the order: the API order number must match it', async () => {
        const merchant = await gate.merchant();
        const { orderId } = await heldWithGeneratedNumber(merchant);
        const before = await stateOf(merchant.orgId);
        const body = order({ externalOrderId: 'GEN-1', totalPrice: '300' });

        // orderNumber defaults to the external id as written: not the IMP-…
        // number the import generated, so it is a different order.
        await expect(codeOf(submit(merchant, body, newKey()))).resolves.toBe(
          'API_ORDER_EXTERNAL_ID_CONFLICT',
        );
        await expect(
          submit(merchant, { ...body, orderNumber: 'IMP-ABC123-2' }, newKey()),
        ).resolves.toMatchObject({ orderId, duplicate: true });
        await gate.drain();

        expect(await stateOf(merchant.orgId)).toEqual(before);
      });

      it('leaves the held path alone: another batch still gets already_imported', async () => {
        const merchant = await gate.merchant();
        const { row } = await heldWithGeneratedNumber(merchant);
        const before = await stateOf(merchant.orgId);

        // Identical or not, a held acceptance reports the collision per row.
        for (const totalPrice of ['300.00', '999.00'])
          await expect(
            gate.services.ingestion.acceptMany(
              { orgId: merchant.orgId, source: merchant.source },
              [
                {
                  ...row,
                  idempotencyKey: `${randomUUID()}:2`,
                  order: { ...row.order, totalPrice },
                },
              ],
              { channel: 'bulk_import', hold: { groupId: randomUUID() } },
            ),
          ).resolves.toEqual([{ status: 'already_imported' }]);

        expect(await stateOf(merchant.orgId)).toEqual(before);
      });
    });
  });
});
