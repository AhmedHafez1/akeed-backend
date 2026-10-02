import type { INestApplication } from '@nestjs/common';
import type { Job } from 'bullmq';
import { plainToInstance } from 'class-transformer';
import { validateOrReject } from 'class-validator';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { Response } from 'supertest';
import * as schema from '../src/infrastructure/database';
import { IntegrationApiKeysRepository } from '../src/infrastructure/database/repositories/integration-api-keys.repository';
import { ManualOrderIngestionRepository } from '../src/infrastructure/database/repositories/manual-order-ingestion.repository';
import {
  creditLedgerEntries,
  creditReservations,
  integrations,
  orders,
  verificationMessageDispatches,
  verifications,
  webhookEvents,
} from '../src/infrastructure/database/schema';
import { IntegrationKeysService } from '../src/modules/integration-keys/integration-keys.service';
import { IMPORT_FIELDS } from '../src/modules/order-imports/mapping/alias-dictionary';
import { StandaloneOrderIngestionService } from '../src/modules/order-ingestion/standalone-order-ingestion.service';
import { StandaloneSourceResolver } from '../src/modules/order-ingestion/standalone-source-resolver';
import { CreateManualOrderDto } from '../src/modules/orders/dto/create-manual-order.dto';
import { WebhookDispatchService } from '../src/modules/webhook-queue/webhook-dispatch.service';
import {
  createOrderApiApp,
  DEFAULT_ORDER_API_LIMITS,
  migrateIntegrationApiKeys,
  postOrder,
} from './contracts/order-api-app';
import {
  releaseGateHarness,
  type ReleaseGateHarness,
} from './contracts/release-gate-harness';

const gate = releaseGateHarness();
type Merchant = Awaited<ReturnType<ReleaseGateHarness['merchant']>>;

const keys = new IntegrationApiKeysRepository(gate.db);
/** Keys are issued and revoked the way Settings does it, never by SQL. */
const keyService = new IntegrationKeysService(keys, gate.services.ingestion);

/**
 * A database nobody answers on: every query fails to connect, as during an
 * outage. Port 1 is never a PostgreSQL server.
 */
const deadClient = postgres(
  'postgresql://e01_test:unreachable@127.0.0.1:1/akeed_e01_test',
  { max: 1, connect_timeout: 2, onnotice: () => undefined },
);
const deadDb = drizzle(deadClient, { schema });

const OPENING_CREDITS = 100;

/** A ready store with a key issued for it. */
async function tenant(options: Parameters<typeof gate.merchant>[0] = {}) {
  const merchant = await gate.merchant(options);
  const issued = await keyService.create(merchant.user, { name: 'Gate key' });
  return { ...merchant, apiKey: issued.secret, key: issued.key };
}

const newKey = () => `order-${randomUUID()}`;

const order = (overrides: Record<string, unknown> = {}) => ({
  externalOrderId: `G-${randomUUID().slice(0, 8)}`,
  customerName: 'Mona Ali',
  customerPhone: '+201001234567',
  totalPrice: '450.00',
  currency: 'EGP',
  paymentMethod: 'cash_on_delivery',
  ...overrides,
});

interface AcceptedBody {
  orderId: string;
  verificationId?: string;
  status: string;
  duplicate: boolean;
}
interface ErrorBody {
  code: string;
  message: string;
  correlationId: string;
}
const accepted = (response: Response) => response.body as AcceptedBody;
const refused = (response: Response) => response.body as ErrorBody;

/** The ingestion command over a broken acceptance store or a broken queue. */
function ingestionWith(parts: {
  acceptance?: ManualOrderIngestionRepository;
  dispatcher?: WebhookDispatchService;
}) {
  return new StandaloneOrderIngestionService(
    parts.acceptance ?? new ManualOrderIngestionRepository(gate.db),
    parts.dispatcher ?? gate.services.dispatcher,
    gate.repositories.verifications,
    new StandaloneSourceResolver(gate.repositories.integrations),
    gate.services.readiness,
  );
}

/**
 * A request whose order is committed and queued while its answer never
 * arrives: the connection drops after the ingestion command returned.
 */
async function postAndLoseResponse(
  apiKey: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
) {
  const real = gate.services.ingestion;
  const lossy = await createOrderApiApp({
    keys,
    ingestion: {
      submitOne: async (...args: Parameters<typeof real.submitOne>) => {
        await real.submitOne(...args);
        throw new Error('socket hang up');
      },
    } as unknown as StandaloneOrderIngestionService,
  });
  try {
    return await postOrder(lossy, apiKey, idempotencyKey, body);
  } finally {
    await lossy.close();
  }
}

async function rowsOf(orgId: string) {
  const [orderRows, eventRows, verificationRows, dispatchRows, holdRows] =
    await Promise.all([
      gate.db.select().from(orders).where(eq(orders.orgId, orgId)),
      gate.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.orgId, orgId)),
      gate.db
        .select()
        .from(verifications)
        .where(eq(verifications.orgId, orgId)),
      gate.db
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.orgId, orgId)),
      gate.db
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.orgId, orgId)),
    ]);
  const verificationIds = new Set(verificationRows.map((row) => row.id));
  return {
    orders: orderRows,
    events: eventRows,
    verifications: verificationRows,
    dispatches: dispatchRows,
    creditHolds: holdRows,
    sends: gate.sends.filter((send) =>
      verificationIds.has(send.verificationId),
    ),
    credit: await gate.repositories.credits.getSummary(orgId),
  };
}

/**
 * AC5 reconciliation: what an organization holds after a case, counted from
 * the tables, and the links between the rows. `sent` is how many of the
 * orders reached the customer: each is one verification, one dispatch ledger
 * row, one credit reservation, one credit spent and one message.
 */
async function expectReconciled(
  orgId: string,
  expected: { orders: number; sent: number },
) {
  const state = await rowsOf(orgId);
  expect({
    orders: state.orders.length,
    events: state.events.length,
    verifications: state.verifications.length,
    dispatches: state.dispatches.length,
    creditHolds: state.creditHolds.length,
    messages: state.sends.length,
    heldCredits: state.credit?.heldCredits,
    availableCredits: state.credit?.availableCredits,
  }).toEqual({
    orders: expected.orders,
    events: expected.orders,
    verifications: expected.sent,
    dispatches: expected.sent,
    creditHolds: expected.sent,
    messages: expected.sent,
    // A message the provider accepted consumes its hold: nothing stays held.
    heldCredits: 0,
    availableCredits: OPENING_CREDITS - expected.sent,
  });
  // One event per order and one verification per sent order, each pointing
  // at a row of this organization.
  const orderIds = state.orders.map((row) => row.id).sort();
  expect(state.events.map((row) => row.orderId).sort()).toEqual(orderIds);
  expect(new Set(state.verifications.map((row) => row.orderId)).size).toBe(
    expected.sent,
  );
  for (const verification of state.verifications)
    expect(orderIds).toContain(verification.orderId);
  expect(state.dispatches.map((row) => row.verificationId).sort()).toEqual(
    state.verifications.map((row) => row.id).sort(),
  );
  expect(state.creditHolds.map((row) => row.verificationId).sort()).toEqual(
    state.verifications.map((row) => row.id).sort(),
  );
  return state;
}

/**
 * US-05-06 release gate over PostgreSQL and real HTTP. The order API is
 * mounted as `main.ts` mounts it (edge, guards, pipe, controller, adapter) in
 * front of the real ingestion command, repositories, worker, hub, send service
 * and credit ledger; keys are issued and revoked through the Settings service.
 * Only the messaging port and the queues are fakes (see `releaseGateHarness`),
 * and the fault cases break one boundary each.
 */
describe('E05 release gate PostgreSQL contract (US-05-06)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await gate.setup();
    await migrateIntegrationApiKeys(gate);
  });
  afterAll(async () => {
    await deadClient.end({ timeout: 1 });
    await gate.teardown();
  });

  // A new app for each test, so no test starts with a used rate-limit bucket.
  beforeEach(async () => {
    app = await createOrderApiApp({ keys, ingestion: gate.services.ingestion });
  });
  afterEach(() => app.close());

  describe('AC1 equivalence: one order through the manual form, a file import and the API', () => {
    const ORDER = {
      phone: '+201055500001',
      name: 'Equal Customer',
      amount: '640.00',
    };
    const CHANNELS = ['manual', 'file_import', 'api'] as const;
    type Channel = (typeof CHANNELS)[number];

    async function viaManual(merchant: Merchant, reference: string) {
      // What the manual form posts, through the DTO transforms and checks the
      // app-wide ValidationPipe applies before the controller.
      const body = plainToInstance(CreateManualOrderDto, {
        customerPhone: ORDER.phone,
        customerName: ORDER.name,
        orderNumber: reference,
        totalPrice: ORDER.amount,
        currency: 'EGP',
        paymentMethod: 'cash_on_delivery',
      });
      await validateOrReject(body);
      const created = await gate.services.orders.createManualOrder(
        merchant.user,
        `equivalence-${randomUUID()}`,
        body,
      );
      await gate.drain();
      return created.orderId;
    }

    /** Upload, map, commit, start and release: the merchant's whole import. */
    async function viaFileImport(merchant: Merchant, reference: string) {
      const bytes = Buffer.from(
        [
          'Order Number,Customer Name,Phone,Amount,Payment Method',
          `${reference},${ORDER.name},${ORDER.phone},${ORDER.amount},cash_on_delivery`,
        ].join('\r\n'),
      );
      const { batchId } = await gate.services.uploads.upload(
        merchant.user,
        merchant.source,
        {
          buffer: bytes,
          size: bytes.length,
          originalname: `equivalence-${randomUUID()}.csv`,
        },
      );
      const columns: Record<string, unknown> = {
        orderReference: 'Order Number',
        customerName: ['Customer Name'],
        phone: 'Phone',
        amount: 'Amount',
        paymentMethod: 'Payment Method',
      };
      await gate.services.mapping.save(
        merchant.user,
        merchant.source,
        batchId,
        {
          mapping: Object.fromEntries(
            IMPORT_FIELDS.map((field) => [field, columns[field] ?? null]),
          ),
          options: {
            country: 'EG',
            defaultCurrency: 'EGP',
            dateFormat: 'auto',
            paymentValueMap: {},
          },
        } as never,
      );
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
      for (let attempt = 0; attempt < 20; attempt++) {
        await gate.services.ticks.tick(merchant.orgId);
        await gate.drain();
        const [batch] = await gate.client<{ status: string }[]>`
          SELECT status FROM order_import_batches WHERE id = ${batchId}`;
        if (batch.status !== 'releasing') break;
      }
      const [row] = await gate.client<{ order_id: string }[]>`
        SELECT order_id FROM order_import_rows
        WHERE batch_id = ${batchId} AND order_id IS NOT NULL`;
      return row.order_id;
    }

    async function viaApi(merchant: Merchant, reference: string) {
      const issued = await keyService.create(merchant.user, { name: 'Gate' });
      const response = await postOrder(app, issued.secret, newKey(), {
        externalOrderId: reference,
        customerName: ORDER.name,
        customerPhone: ORDER.phone,
        totalPrice: ORDER.amount,
        currency: 'EGP',
        paymentMethod: 'cash_on_delivery',
      });
      expect(response.status).toBe(202);
      await gate.drain();
      return accepted(response).orderId;
    }

    const SUBMIT: Record<
      Channel,
      (merchant: Merchant, reference: string) => Promise<string>
    > = { manual: viaManual, file_import: viaFileImport, api: viaApi };

    /**
     * Three stores with identical settings and balances, one per channel, each
     * given the same order. From here on each lives the same life.
     */
    async function threeChannels(reference: string) {
      const sides = {} as Record<
        Channel,
        { merchant: Merchant; orderId: string }
      >;
      for (const channel of CHANNELS) {
        const merchant = await gate.merchant();
        sides[channel] = {
          merchant,
          orderId: await SUBMIT[channel](merchant, reference),
        };
      }
      return sides;
    }

    async function verificationOf(orderId: string) {
      const [row] = await gate.db
        .select()
        .from(verifications)
        .where(eq(verifications.orderId, orderId));
      return row;
    }

    /** Everything the core produced for one order, ids and clocks removed. */
    async function snapshot(orgId: string, orderId: string) {
      const verification = await verificationOf(orderId);
      const [stored] = await gate.db
        .select()
        .from(orders)
        .where(eq(orders.id, orderId));
      const [event] = await gate.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.orderId, orderId));
      const dispatchRows = await gate.db
        .select()
        .from(verificationMessageDispatches)
        .where(
          eq(verificationMessageDispatches.verificationId, verification.id),
        )
        .orderBy(asc(verificationMessageDispatches.createdAt));
      const ledger = await gate.db
        .select()
        .from(creditLedgerEntries)
        .where(eq(creditLedgerEntries.orgId, orgId))
        .orderBy(asc(creditLedgerEntries.createdAt));
      const reservations = await gate.db
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.orgId, orgId));
      const balance = await gate.repositories.credits.getSummary(orgId);
      const projected = await gate.repositories.orders.findDashboardOrderById(
        orderId,
        orgId,
      );
      const listed = await gate.services.verifications.listByOrg(orgId, {
        limit: 100,
      } as never);
      const sentAt = verification.lastSentAt
        ? new Date(verification.lastSentAt).getTime()
        : 0;
      const at = (value: unknown) => (value ? 'set' : null);
      return {
        normalizedOrder: {
          orderNumber: stored.orderNumber,
          customerPhone: stored.customerPhone,
          customerName: stored.customerName,
          totalPrice: stored.totalPrice,
          currency: stored.currency,
          paymentMethod: stored.paymentMethod,
          isTest: stored.isTest,
        },
        event: {
          platform: event.platform,
          jobType: event.jobType,
          status: event.status,
          lastError: event.lastError,
        },
        verification: {
          status: verification.status,
          followUpAttempts: verification.followUpAttempts,
          lastSentAt: at(verification.lastSentAt),
          confirmedAt: at(verification.confirmedAt),
          canceledAt: at(verification.canceledAt),
          noReplyAt: at(verification.noReplyAt),
          followUpSentAt: at(verification.followUpSentAt),
        },
        dispatchLedger: dispatchRows.map((row) => ({
          kind: row.kind,
          state: row.state,
          accountingMode: row.accountingMode,
          templateName: row.templateName,
        })),
        messages: gate.sends
          .filter((send) => send.verificationId === verification.id)
          .map((send) => ({
            to: send.to,
            orderNumber: send.orderNumber,
            totalPrice: send.totalPrice,
          })),
        credit: {
          posted: balance?.postedBalance,
          held: balance?.heldCredits,
          available: balance?.availableCredits,
          ledger: ledger.map((entry) => ({
            type: entry.type,
            quantity: entry.quantity,
          })),
          reservations: reservations
            .map((reservation) => ({
              kind: reservation.kind,
              status: reservation.status,
              quantity: reservation.quantity,
            }))
            .sort((a, b) => a.kind.localeCompare(b.kind)),
        },
        followUp: gate.automationJobs
          .filter((job) => job.verificationId === verification.id)
          .map((job) => ({
            kind: job.kind,
            minutesAfterSend: Math.round(
              (job.dueAt.getTime() - sentAt) / 60_000,
            ),
          })),
        dashboard: {
          order: projected
            ? {
                status: projected.retryGuardStatus,
                reason: projected.retryGuardReason,
                retryable: projected.retryGuardRetryable,
                verificationStatus: projected.verificationStatus,
              }
            : null,
          // The Verifications list row the merchant reads, as the controller
          // returns it. Ids and the channel's own order identity are removed;
          // a timestamp is compared as present or absent.
          verificationsList: listed.data.map((row) =>
            Object.fromEntries(
              Object.entries(row)
                .filter(
                  ([name]) =>
                    !['id', 'order_id', 'external_order_id'].includes(name),
                )
                .map(([name, value]) => [
                  name,
                  /(_at|_for)$/.test(name) ? at(value) : value,
                ]),
            ),
          ),
        },
      };
    }

    type Sides = Awaited<ReturnType<typeof threeChannels>>;

    function stageOf(sides: Sides) {
      return Promise.all(
        CHANNELS.map((channel) =>
          snapshot(sides[channel].merchant.orgId, sides[channel].orderId),
        ),
      );
    }

    /** The file import and the API must each read exactly like the manual form. */
    function expectIdentical(stages: Awaited<ReturnType<typeof stageOf>>[]) {
      for (const [manual, fileImport, api] of stages) {
        expect(fileImport).toEqual(manual);
        expect(api).toEqual(manual);
      }
    }

    it.each(['confirm', 'cancel'] as const)(
      'customer reply (%s): identical order, verification, dispatch ledger, credit, follow-up jobs and dashboard',
      async (action) => {
        const sides = await threeChannels(`EQ-${action}`);
        const stages = [await stageOf(sides)];
        for (const channel of CHANNELS) {
          const verification = await verificationOf(sides[channel].orderId);
          await gate.reply(verification.id, ORDER.phone, action);
        }
        stages.push(await stageOf(sides));

        expectIdentical(stages);
        expect(stages[0][0]).toMatchObject({
          normalizedOrder: {
            orderNumber: `EQ-${action}`,
            customerPhone: ORDER.phone,
            totalPrice: ORDER.amount,
          },
          event: { status: 'completed' },
          verification: { status: 'sent' },
          dispatchLedger: [{ kind: 'initial' }],
          messages: [{ to: ORDER.phone, orderNumber: `EQ-${action}` }],
          credit: { held: 0, available: OPENING_CREDITS - 1 },
          followUp: [
            { kind: 'follow_up', minutesAfterSend: 60 },
            { kind: 'no_reply', minutesAfterSend: 180 },
          ],
        });
        expect(stages[1][0]).toMatchObject({
          verification: {
            status: action === 'confirm' ? 'confirmed' : 'canceled',
          },
          dashboard: {
            order: {
              verificationStatus:
                action === 'confirm' ? 'confirmed' : 'canceled',
            },
          },
        });
        expect(stages[1][0].dashboard.verificationsList).toHaveLength(1);
      },
    );

    it('no reply: identical follow-up, no-reply escalation, credit and dashboard', async () => {
      const sides = await threeChannels('EQ-noreply');
      const stages = [await stageOf(sides)];
      for (const kind of ['follow_up', 'no_reply'] as const) {
        for (const channel of CHANNELS) {
          const verification = await verificationOf(sides[channel].orderId);
          const job = gate.automationJobs.find(
            (candidate) =>
              candidate.verificationId === verification.id &&
              candidate.kind === kind,
          )!;
          await gate.runAutomation(job);
        }
        stages.push(await stageOf(sides));
      }

      expectIdentical(stages);
      expect(stages[2][0]).toMatchObject({
        verification: { status: 'no_reply', followUpAttempts: 1 },
        dispatchLedger: [{ kind: 'initial' }, { kind: 'follow_up' }],
        dashboard: { order: { verificationStatus: 'no_reply' } },
      });
    });

    it('differs only in ingestionType and the channel envelope extras', async () => {
      const sides = await threeChannels('EQ-envelope');
      const stored = {} as Record<
        Channel,
        {
          order: typeof orders.$inferSelect;
          payload: Record<string, unknown>;
          event: typeof webhookEvents.$inferSelect;
        }
      >;
      for (const channel of CHANNELS) {
        const [row] = await gate.db
          .select()
          .from(orders)
          .where(eq(orders.id, sides[channel].orderId));
        const [event] = await gate.db
          .select()
          .from(webhookEvents)
          .where(eq(webhookEvents.orderId, sides[channel].orderId));
        stored[channel] = {
          order: row,
          payload: event.rawPayload as Record<string, unknown>,
          event,
        };
      }
      const differing = (a: Channel, b: Channel) => {
        const names = new Set([
          ...Object.keys(stored[a].payload),
          ...Object.keys(stored[b].payload),
        ]);
        return [...names]
          .filter(
            (name) =>
              JSON.stringify(stored[a].payload[name]) !==
              JSON.stringify(stored[b].payload[name]),
          )
          .sort();
      };

      // The API and a file import describe the same order with the same
      // identity: one canonical order, key for key, and one fingerprint.
      expect(differing('api', 'file_import')).toEqual([
        'importBatchId',
        'importRowNumber',
        'ingestionType',
      ]);
      expect(stored.api.payload.submissionFingerprint).toBe(
        stored.file_import.payload.submissionFingerprint,
      );
      expect(stored.api.order.externalOrderId).toBe('ref:eq-envelope');
      expect(stored.file_import.order.externalOrderId).toBe('ref:eq-envelope');

      // The manual form has its own identity scheme (E04), so the identity
      // and the fingerprint over it differ, and nothing else does.
      expect(differing('api', 'manual')).toEqual([
        'ingestionType',
        'order',
        'submissionFingerprint',
      ]);
      const { externalOrderId: manualId, ...manualOrder } = stored.manual
        .payload.order as Record<string, unknown>;
      const { externalOrderId: apiId, ...apiOrder } = stored.api.payload
        .order as Record<string, unknown>;
      expect(JSON.stringify(apiOrder)).toBe(JSON.stringify(manualOrder));
      expect(manualId).toMatch(/^manual-[0-9a-f]{40}$/);
      expect(apiId).toBe('ref:eq-envelope');

      expect({
        manual: stored.manual.payload.ingestionType,
        file_import: stored.file_import.payload.ingestionType,
        api: stored.api.payload.ingestionType,
      }).toEqual({ manual: 'manual', file_import: 'bulk_import', api: 'api' });
      // The stored event differs in its namespaced key and the import's hold
      // bookkeeping, never in how it is processed.
      expect(stored.api.event.idempotencyKey).toMatch(/^api:order-/);
      expect(stored.file_import.event.idempotencyKey).toMatch(/^import:/);
      expect(stored.manual.event.idempotencyKey).toMatch(/^equivalence-/);
      expect({
        manual: stored.manual.event.holdState,
        file_import: stored.file_import.event.holdState,
        api: stored.api.event.holdState,
      }).toEqual({ manual: 'none', file_import: 'released', api: 'none' });
    });
  });

  describe('AC3 tenant isolation: two organizations, each with its own key', () => {
    it('credentials: a key writes only into its own organization, and the other cannot list or revoke it', async () => {
      const a = await tenant();
      const b = await tenant();

      const response = await postOrder(app, a.apiKey, newKey(), order());
      expect(response.status).toBe(202);
      await gate.drain();
      await expectReconciled(a.orgId, { orders: 1, sent: 1 });
      await expectReconciled(b.orgId, { orders: 0, sent: 0 });

      const listedForB = await keyService.list(b.user);
      expect(listedForB.keys.map((key) => key.id)).toEqual([b.key.id]);
      await expect(keyService.revoke(b.user, a.key.id)).rejects.toMatchObject({
        response: { code: 'API_KEY_NOT_FOUND' },
      });
      // Still active: the other organization's attempt changed nothing.
      const replay = await postOrder(app, a.apiKey, newKey(), order());
      expect(replay.status).toBe(202);

      // A key cannot be pointed at another organization's store, even by a
      // direct write: the database refuses the row.
      await expect(
        gate.client`
          UPDATE integration_api_keys SET integration_id = ${b.integrationId}
          WHERE id = ${a.key.id}`,
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('idempotency responses and external-ID replays: the same key and order id in two organizations are unrelated', async () => {
      const a = await tenant();
      const b = await tenant();
      const sharedKey = newKey();
      const forA = order({ externalOrderId: 'SHARED-1', totalPrice: '100.00' });
      const forB = order({ externalOrderId: 'SHARED-1', totalPrice: '200.00' });

      const first = await postOrder(app, a.apiKey, sharedKey, forA);
      // Same Idempotency-Key, same externalOrderId, different content: inside
      // one organization this is a 409; across two it is a new order.
      const second = await postOrder(app, b.apiKey, sharedKey, forB);
      await gate.drain();
      expect([first.status, second.status]).toEqual([202, 202]);
      expect(accepted(second)).toMatchObject({ duplicate: false });
      expect(accepted(second).orderId).not.toBe(accepted(first).orderId);

      // Each organization replays its own order, by key and by order id.
      for (const [side, body, original] of [
        [a, forA, accepted(first)],
        [b, forB, accepted(second)],
      ] as const) {
        for (const key of [sharedKey, newKey()]) {
          const replay = await postOrder(app, side.apiKey, key, body);
          expect(replay.status).toBe(202);
          expect(accepted(replay)).toMatchObject({
            orderId: original.orderId,
            duplicate: true,
          });
        }
      }

      // B sending A's content meets B's own order, and the refusal names
      // nothing of A's.
      const conflict = await postOrder(app, b.apiKey, newKey(), forA);
      expect(conflict.status).toBe(409);
      expect(refused(conflict).code).toBe('API_ORDER_EXTERNAL_ID_CONFLICT');
      for (const foreign of [
        accepted(first).orderId,
        a.orgId,
        a.integrationId,
        a.key.prefix,
      ])
        expect(JSON.stringify(conflict.body)).not.toContain(foreign);

      await gate.drain();
      const [stateA, stateB] = [
        await expectReconciled(a.orgId, { orders: 1, sent: 1 }),
        await expectReconciled(b.orgId, { orders: 1, sent: 1 }),
      ];
      expect(stateA.sends.map((send) => send.totalPrice)).not.toEqual(
        stateB.sends.map((send) => send.totalPrice),
      );
    });

    it('orders: the dashboard, the Verifications list and retry never show or touch the other organization', async () => {
      const a = await tenant();
      const b = await tenant();
      const response = await postOrder(app, a.apiKey, newKey(), order());
      await gate.drain();
      const { orderId } = accepted(response);

      const ownList = await gate.services.verifications.listByOrg(a.orgId, {
        limit: 100,
      } as never);
      expect(ownList.data.map((row) => row.order_id)).toEqual([orderId]);
      const otherList = await gate.services.verifications.listByOrg(b.orgId, {
        limit: 100,
      } as never);
      expect(otherList.data).toEqual([]);
      expect(
        await gate.repositories.orders.findDashboardOrderById(orderId, b.orgId),
      ).toBeFalsy();
      await expect(
        gate.services.orders.retryOrderVerification(b.user, orderId),
      ).rejects.toMatchObject({ response: { code: 'MANUAL_ORDER_NOT_FOUND' } });
    });

    it('usage: credits are held and refused per organization', async () => {
      const a = await tenant({ credits: 1 });
      const b = await tenant();

      expect((await postOrder(app, a.apiKey, newKey(), order())).status).toBe(
        202,
      );
      await gate.drain();
      // A is out of credit. That is A's answer alone.
      const denied = await postOrder(app, a.apiKey, newKey(), order());
      expect(refused(denied).code).toBe('INSUFFICIENT_CREDITS');
      expect((await postOrder(app, b.apiKey, newKey(), order())).status).toBe(
        202,
      );
      await gate.drain();

      const [stateA, stateB] = [await rowsOf(a.orgId), await rowsOf(b.orgId)];
      expect({
        orders: stateA.orders.length,
        holds: stateA.creditHolds.length,
        held: stateA.credit?.heldCredits,
        available: stateA.credit?.availableCredits,
      }).toEqual({ orders: 1, holds: 1, held: 0, available: 0 });
      await expectReconciled(b.orgId, { orders: 1, sent: 1 });
      expect(stateB.creditHolds.map((hold) => hold.orgId)).toEqual([b.orgId]);
    });

    it('usage: one organization at its request limit does not throttle another', async () => {
      const a = await tenant();
      const b = await tenant();
      const tight = await createOrderApiApp({
        keys,
        ingestion: gate.services.ingestion,
        limits: { ...DEFAULT_ORDER_API_LIMITS, perIntegrationPerMinute: 2 },
      });
      try {
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 3; attempt++)
          statuses.push(
            (await postOrder(tight, a.apiKey, newKey(), order())).status,
          );
        expect(statuses).toEqual([202, 202, 429]);
        expect(
          (await postOrder(tight, b.apiKey, newKey(), order())).status,
        ).toBe(202);
      } finally {
        await tight.close();
      }
      await gate.drain();
      // The throttled request never reached the ingestion command.
      await expectReconciled(a.orgId, { orders: 2, sent: 2 });
      await expectReconciled(b.orgId, { orders: 1, sent: 1 });
    });

    it('errors: every refusal has the one envelope and names no tenant, and a bad key reads the same whoever owns it', async () => {
      const a = await tenant();
      const b = await tenant();
      await keyService.revoke(b.user, b.key.id);
      const taken = order({ externalOrderId: 'ERR-1' });
      await postOrder(app, a.apiKey, 'order-errors-0001', taken);

      const refusals = [
        // Revoked (B's), unknown, and A's key with one character changed.
        await postOrder(app, b.apiKey, newKey(), order()),
        await postOrder(
          app,
          `${a.apiKey.slice(0, -1)}${a.apiKey.endsWith('0') ? '1' : '0'}`,
          newKey(),
          order(),
        ),
        await postOrder(app, a.apiKey, newKey(), order({ totalPrice: 'x' })),
        await postOrder(app, a.apiKey, 'order-errors-0001', {
          ...taken,
          totalPrice: '1.00',
        }),
        await postOrder(app, a.apiKey, newKey(), { ...taken, city: 'Giza' }),
      ];

      expect(
        refusals.map((response) => [response.status, refused(response).code]),
      ).toEqual([
        [401, 'API_KEY_INVALID'],
        [401, 'API_KEY_INVALID'],
        [400, 'API_VALIDATION_FAILED'],
        [409, 'API_ORDER_IDEMPOTENCY_CONFLICT'],
        [409, 'API_ORDER_EXTERNAL_ID_CONFLICT'],
      ]);
      // A revoked key and a wrong one are indistinguishable.
      const { correlationId: first, ...revokedBody } = refused(refusals[0]);
      const { correlationId: second, ...wrongBody } = refused(refusals[1]);
      expect(revokedBody).toEqual(wrongBody);
      expect(first).not.toBe(second);
      for (const response of refusals) {
        expect(
          Object.keys(response.body as object).filter(
            (name) =>
              !['code', 'message', 'correlationId', 'fieldErrors'].includes(
                name,
              ),
          ),
        ).toEqual([]);
        for (const identifier of [
          a.orgId,
          b.orgId,
          a.integrationId,
          b.integrationId,
          a.key.id,
          b.key.id,
          a.key.prefix,
          b.key.prefix,
        ])
          expect(JSON.stringify(response.body)).not.toContain(identifier);
      }
    });
  });

  describe('AC4 revocation', () => {
    it('refuses the key at once, for a replay as for a new order, and stores nothing', async () => {
      const store = await tenant();
      const key = newKey();
      const body = order();
      const before = await postOrder(app, store.apiKey, key, body);
      expect(before.status).toBe(202);
      const sendsBefore = gate.sends.length;

      const revoked = await keyService.revoke(store.user, store.key.id);
      expect(revoked).toMatchObject({ id: store.key.id, status: 'revoked' });

      // The very next requests, with no wait: the replay of an accepted
      // order, a new order, and a burst.
      const afterwards = await Promise.all([
        postOrder(app, store.apiKey, key, body),
        postOrder(app, store.apiKey, newKey(), order()),
        ...Array.from({ length: 5 }, () =>
          postOrder(app, store.apiKey, newKey(), order()),
        ),
      ]);
      expect(
        afterwards.map((response) => [response.status, refused(response).code]),
      ).toEqual(afterwards.map(() => [401, 'API_KEY_INVALID']));

      // Revoking again is the same answer and changes nothing.
      await expect(
        keyService.revoke(store.user, store.key.id),
      ).resolves.toMatchObject({
        status: 'revoked',
        revokedAt: revoked.revokedAt,
      });
      const state = await rowsOf(store.orgId);
      expect(state.orders).toHaveLength(1);
      expect(state.events).toHaveLength(1);
      expect(gate.sends.length).toBe(sendsBefore);
    });

    it('keeps an accepted order alive and auditable: it is sent, confirmed and shown after its key is gone', async () => {
      const store = await tenant();
      const key = newKey();
      const body = order({ externalOrderId: 'REV-1' });
      const response = await postOrder(app, store.apiKey, key, body);
      const { orderId } = accepted(response);
      // Accepted, not yet processed: the worker has not run.
      await keyService.revoke(store.user, store.key.id);

      await gate.drain();
      const state = await expectReconciled(store.orgId, { orders: 1, sent: 1 });
      await gate.reply(
        state.verifications[0].id,
        body.customerPhone,
        'confirm',
      );

      const projected = await gate.repositories.orders.findDashboardOrderById(
        orderId,
        store.orgId,
      );
      expect(projected).toMatchObject({
        id: orderId,
        externalOrderId: 'ref:rev-1',
        verificationStatus: 'confirmed',
      });
      // The audit trail: the key stays listed as revoked with its usage, the
      // order keeps its channel, and neither row names the credential.
      const listed = await keyService.list(store.user);
      expect(listed.keys).toEqual([
        expect.objectContaining({
          id: store.key.id,
          prefix: store.key.prefix,
          status: 'revoked',
          revokedAt: expect.any(String) as unknown,
          lastUsedAt: expect.any(String) as unknown,
        }),
      ]);
      expect(state.events[0].rawPayload).toMatchObject({
        ingestionType: 'api',
      });
      const storedRows = JSON.stringify([state.orders, state.events]);
      expect(storedRows).not.toContain(store.key.prefix);
      expect(storedRows).not.toContain(store.key.id);

      // The order belongs to the store, not the credential: a new key
      // replays it under the old Idempotency-Key.
      const rotated = await keyService.create(store.user, { name: 'Rotated' });
      const replay = await postOrder(app, rotated.secret, key, body);
      expect(replay.status).toBe(202);
      expect(accepted(replay)).toEqual({
        orderId,
        verificationId: state.verifications[0].id,
        status: 'accepted',
        duplicate: true,
      });
      await gate.drain();
      await expectReconciled(store.orgId, { orders: 1, sent: 1 });
    });

    it.each([
      [
        'automatic verification is switched off',
        { isAutoVerifyEnabled: false },
      ],
      ['the store is deactivated', { isActive: false }],
    ])(
      'follows source state: when %s before the worker runs, the order ends exactly like a manual order',
      async (_label, change) => {
        const viaApi = await tenant();
        const viaManual = await gate.merchant();
        const response = await postOrder(
          app,
          viaApi.apiKey,
          newKey(),
          order({ externalOrderId: 'SRC-1' }),
        );
        await keyService.revoke(viaApi.user, viaApi.key.id);
        const manualBody = plainToInstance(CreateManualOrderDto, {
          customerPhone: '+201001234567',
          customerName: 'Mona Ali',
          orderNumber: 'SRC-1',
          totalPrice: '450.00',
          currency: 'EGP',
          paymentMethod: 'cash_on_delivery',
        });
        const manual = await gate.services.orders.createManualOrder(
          viaManual.user,
          newKey(),
          manualBody,
        );
        for (const side of [viaApi, viaManual])
          await gate.db
            .update(integrations)
            .set(change)
            .where(eq(integrations.id, side.integrationId));
        await gate.drain();

        const outcome = async (orgId: string, orderId: string) => {
          const state = await rowsOf(orgId);
          const projected =
            await gate.repositories.orders.findDashboardOrderById(
              orderId,
              orgId,
            );
          return {
            event: {
              status: state.events[0].status,
              lastError: state.events[0].lastError,
            },
            verifications: state.verifications.map((row) => row.status),
            messages: state.sends.length,
            creditHolds: state.creditHolds.length,
            dashboard: projected && {
              status: projected.retryGuardStatus,
              reason: projected.retryGuardReason,
              retryable: projected.retryGuardRetryable,
            },
          };
        };
        const api = await outcome(viaApi.orgId, accepted(response).orderId);
        expect(api).toEqual(await outcome(viaManual.orgId, manual.orderId));
        // The order is still there to be read, whatever the source decided.
        expect(api.dashboard).toBeTruthy();
      },
    );
  });

  describe('AC5 fault recovery: no duplicate business effect, counts reconciled after each case', () => {
    it('concurrent duplicates under one Idempotency-Key: one order, every request answers it', async () => {
      const store = await tenant();
      const key = newKey();
      const body = order();

      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          postOrder(app, store.apiKey, key, body),
        ),
      );
      await gate.drain();

      expect(responses.map((response) => response.status)).toEqual(
        responses.map(() => 202),
      );
      const answers = responses.map(accepted);
      expect(new Set(answers.map((answer) => answer.orderId)).size).toBe(1);
      expect(answers.filter((answer) => !answer.duplicate)).toHaveLength(1);
      await expectReconciled(store.orgId, { orders: 1, sent: 1 });
    });

    it('concurrent duplicates under different keys: the order identity keeps them one order', async () => {
      const store = await tenant();
      const body = order();

      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          postOrder(app, store.apiKey, newKey(), body),
        ),
      );
      await gate.drain();

      expect(responses.map((response) => response.status)).toEqual(
        responses.map(() => 202),
      );
      const answers = responses.map(accepted);
      expect(new Set(answers.map((answer) => answer.orderId)).size).toBe(1);
      expect(answers.filter((answer) => !answer.duplicate)).toHaveLength(1);
      await expectReconciled(store.orgId, { orders: 1, sent: 1 });
    });

    it.each([
      ['one Idempotency-Key', true, 'API_ORDER_IDEMPOTENCY_CONFLICT'],
      ['different keys', false, 'API_ORDER_EXTERNAL_ID_CONFLICT'],
    ])(
      'conflicting payloads sent together under %s: one content wins, the other is refused',
      async (_label, sameKey, code) => {
        const store = await tenant();
        const key = newKey();
        const contents = [
          order({ externalOrderId: 'CF-1', totalPrice: '100.00' }),
          order({ externalOrderId: 'CF-1', totalPrice: '200.00' }),
        ];

        const responses = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            postOrder(
              app,
              store.apiKey,
              sameKey ? key : newKey(),
              contents[index % 2],
            ),
          ),
        );
        await gate.drain();

        const state = await expectReconciled(store.orgId, {
          orders: 1,
          sent: 1,
        });
        const winner = state.orders[0].totalPrice === '100.00' ? 0 : 1;
        responses.forEach((response, index) => {
          if (index % 2 === winner) {
            expect(response.status).toBe(202);
            expect(accepted(response).orderId).toBe(state.orders[0].id);
          } else {
            expect(response.status).toBe(409);
            expect(refused(response).code).toBe(code);
          }
        });
        expect(
          responses.filter(
            (response) =>
              response.status === 202 && !accepted(response).duplicate,
          ),
        ).toHaveLength(1);
        // The customer was asked about the order that was kept.
        expect(state.sends.map((send) => send.totalPrice)).toEqual([
          `${state.orders[0].totalPrice} EGP`,
        ]);
      },
    );

    it('database outage for the whole request: a safe 500, nothing stored, and the retry is the first acceptance', async () => {
      const store = await tenant();
      const key = newKey();
      const body = order();
      const down = await createOrderApiApp({
        keys: new IntegrationApiKeysRepository(deadDb),
        ingestion: ingestionWith({
          acceptance: new ManualOrderIngestionRepository(deadDb),
        }),
      });
      let failed: Response;
      try {
        failed = await postOrder(down, store.apiKey, key, body);
      } finally {
        await down.close();
      }

      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({
        code: 'API_INTERNAL_ERROR',
        message: expect.stringContaining('Retry with the same') as unknown,
        correlationId: failed.headers['x-correlation-id'],
      });
      // No driver text, address or SQL reaches the integrator.
      expect(JSON.stringify(failed.body)).not.toMatch(
        /ECONNREFUSED|127\.0\.0\.1|postgres|select|integration_api_keys/i,
      );
      await expectReconciled(store.orgId, { orders: 0, sent: 0 });

      // The database is back: same key, same body.
      const retry = await postOrder(app, store.apiKey, key, body);
      await gate.drain();
      expect(retry.status).toBe(202);
      expect(accepted(retry)).toMatchObject({ duplicate: false });
      await expectReconciled(store.orgId, { orders: 1, sent: 1 });
    });

    it('database outage at the acceptance transaction: 503 API_ORDER_ACCEPTANCE_FAILED, nothing stored, retry accepted once', async () => {
      const store = await tenant();
      const key = newKey();
      const body = order();
      // Authentication and the readiness reads succeed; the write does not.
      const failing = await createOrderApiApp({
        keys,
        ingestion: ingestionWith({
          acceptance: new ManualOrderIngestionRepository(deadDb),
        }),
      });
      let failed: Response;
      try {
        failed = await postOrder(failing, store.apiKey, key, body);
      } finally {
        await failing.close();
      }

      expect(failed.status).toBe(503);
      expect(refused(failed).code).toBe('API_ORDER_ACCEPTANCE_FAILED');
      await expectReconciled(store.orgId, { orders: 0, sent: 0 });

      const retry = await postOrder(app, store.apiKey, key, body);
      await gate.drain();
      expect(retry.status).toBe(202);
      expect(accepted(retry)).toMatchObject({ duplicate: false });
      await expectReconciled(store.orgId, { orders: 1, sent: 1 });
    });

    it('response lost after commit: the retry answers the committed order, before and after the worker runs', async () => {
      const store = await tenant();
      const key = newKey();
      const body = order();
      const lost = await postAndLoseResponse(store.apiKey, key, body);
      expect(lost.status).toBe(500);
      const committed = await rowsOf(store.orgId);
      expect(committed.orders).toHaveLength(1);

      const early = await postOrder(app, store.apiKey, key, body);
      expect(early.status).toBe(202);
      expect(accepted(early)).toEqual({
        orderId: committed.orders[0].id,
        status: 'accepted',
        duplicate: true,
      });
      await gate.drain();
      const late = await postOrder(app, store.apiKey, key, body);
      await gate.drain();

      const state = await expectReconciled(store.orgId, { orders: 1, sent: 1 });
      expect(accepted(late)).toEqual({
        orderId: committed.orders[0].id,
        verificationId: state.verifications[0].id,
        status: 'accepted',
        duplicate: true,
      });
      expect(
        gate.dispatchedIds.filter((id) => id === state.events[0].id),
      ).toHaveLength(1);
    });

    it('response lost on the last credit: the retry still answers the committed order, and only a new order is refused', async () => {
      const store = await tenant({ credits: 1 });
      const key = newKey();
      const body = order();
      await postAndLoseResponse(store.apiKey, key, body);
      await gate.drain();
      // The message went out and used the store's only credit.
      const committed = await rowsOf(store.orgId);
      expect(committed.sends).toHaveLength(1);
      expect(committed.credit?.availableCredits).toBe(0);

      // The same request, and the same order under a new key: both are the
      // stored order. Neither needs a credit, so neither is a credit refusal.
      for (const retryKey of [key, newKey()]) {
        const retry = await postOrder(app, store.apiKey, retryKey, body);
        expect(retry.status).toBe(202);
        expect(accepted(retry)).toEqual({
          orderId: committed.orders[0].id,
          verificationId: committed.verifications[0].id,
          status: 'accepted',
          duplicate: true,
        });
      }
      // Changed content is still the conflict it would be with credit.
      const conflict = await postOrder(app, store.apiKey, key, {
        ...body,
        totalPrice: '1.00',
      });
      expect(refused(conflict).code).toBe('API_ORDER_IDEMPOTENCY_CONFLICT');
      // A new order does need a credit.
      const fresh = await postOrder(app, store.apiKey, newKey(), order());
      expect([fresh.status, refused(fresh).code]).toEqual([
        409,
        'INSUFFICIENT_CREDITS',
      ]);
      await gate.drain();

      const state = await rowsOf(store.orgId);
      expect({
        orders: state.orders.length,
        events: state.events.length,
        verifications: state.verifications.length,
        dispatches: state.dispatches.length,
        creditHolds: state.creditHolds.length,
        messages: state.sends.length,
        availableCredits: state.credit?.availableCredits,
      }).toEqual({
        orders: 1,
        events: 1,
        verifications: 1,
        dispatches: 1,
        creditHolds: 1,
        messages: 1,
        availableCredits: 0,
      });
    });

    it('queue outage after commit: 503 API_ORDER_DISPATCH_FAILED, and the recovery sweep sends the order once without a client retry', async () => {
      const store = await tenant();
      const key = newKey();
      const body = order();
      // The real dispatcher over a queue that refuses jobs (Redis down).
      const queueDown = await createOrderApiApp({
        keys,
        ingestion: ingestionWith({
          dispatcher: new WebhookDispatchService(
            {
              add: () => Promise.reject(new Error('Connection is closed.')),
            } as never,
            gate.repositories.events,
            { get: () => undefined } as never,
          ),
        }),
      });
      let failed: Response;
      try {
        failed = await postOrder(queueDown, store.apiKey, key, body);
      } finally {
        await queueDown.close();
      }

      expect(failed.status).toBe(503);
      expect(refused(failed).code).toBe('API_ORDER_DISPATCH_FAILED');
      // The order is durable; nothing has been sent or charged.
      const committed = await rowsOf(store.orgId);
      expect({
        orders: committed.orders.length,
        events: committed.events.length,
        verifications: committed.verifications.length,
        creditHolds: committed.creditHolds.length,
        messages: committed.sends.length,
      }).toEqual({
        orders: 1,
        events: 1,
        verifications: 0,
        creditHolds: 0,
        messages: 0,
      });
      expect(committed.events[0]).toMatchObject({
        status: 'pending',
        dispatchRequired: true,
        dispatchAttempts: 1,
      });

      // A retry inside the dispatch back-off is the same honest 503: the
      // order stays saved, and nothing is stored or queued a second time.
      const tooSoon = await postOrder(app, store.apiKey, key, body);
      expect([tooSoon.status, refused(tooSoon).code]).toEqual([
        503,
        'API_ORDER_DISPATCH_FAILED',
      ]);
      expect((await rowsOf(store.orgId)).events).toHaveLength(1);
      expect(gate.dispatchedIds).not.toContain(committed.events[0].id);

      // The queue is back and the dispatch back-off has passed. The client
      // never retried; the sweep finds the event.
      await gate.client`
        UPDATE webhook_events SET next_dispatch_at = NOW() - interval '1 second'
        WHERE id = ${committed.events[0].id}`;
      const swept = await gate.services.reconciler.reconcileOnce();
      expect(swept.dispatched).toBeGreaterThanOrEqual(1);
      await gate.drain();
      await gate.services.reconciler.reconcileOnce();
      await gate.drain();
      const state = await expectReconciled(store.orgId, { orders: 1, sent: 1 });

      // A late client retry finds the order processed.
      const retry = await postOrder(app, store.apiKey, key, body);
      await gate.drain();
      expect(accepted(retry)).toEqual({
        orderId: committed.orders[0].id,
        verificationId: state.verifications[0].id,
        status: 'accepted',
        duplicate: true,
      });
      await expectReconciled(store.orgId, { orders: 1, sent: 1 });
    });
  });

  describe('AC6 end to end', () => {
    it('an API order travels through the messaging port to a confirmed outcome on the dashboard', async () => {
      const store = await tenant();
      const sendsBefore = gate.sends.length;
      const body = order({
        externalOrderId: '#E2E-7001',
        customerPhone: '+201055512345',
        totalPrice: '1250.50',
        city: 'Cairo',
      });

      const response = await postOrder(app, store.apiKey, newKey(), body);
      expect(response.status).toBe(202);
      expect(response.headers['x-correlation-id']).toEqual(expect.any(String));
      const { orderId } = accepted(response);
      await gate.drain();

      // The customer received one WhatsApp message for this order.
      const [message] = gate.sends.slice(sendsBefore);
      expect(gate.sends.length).toBe(sendsBefore + 1);
      expect(message).toMatchObject({
        to: '+201055512345',
        orderNumber: '#E2E-7001',
      });
      const beforeReply = await gate.services.verifications.listByOrg(
        store.orgId,
        { limit: 100 } as never,
      );
      expect(beforeReply.data).toEqual([
        expect.objectContaining({
          id: message.verificationId,
          order_id: orderId,
          status: 'sent',
          order_number: '#E2E-7001',
          platform: 'standalone',
        }),
      ]);

      // The customer taps Confirm.
      await gate.reply(message.verificationId, message.to, 'confirm');

      const afterReply = await gate.services.verifications.listByOrg(
        store.orgId,
        { limit: 100 } as never,
      );
      expect(afterReply.data).toEqual([
        expect.objectContaining({
          id: message.verificationId,
          order_id: orderId,
          status: 'confirmed',
          confirmation_source: 'customer',
          customer_phone: '+201055512345',
          currency: 'EGP',
        }),
      ]);
      expect(Number(afterReply.data[0].total_price)).toBe(1250.5);
      expect(afterReply.data[0].confirmed_at).toEqual(expect.any(String));
      expect(
        await gate.repositories.orders.findDashboardOrderById(
          orderId,
          store.orgId,
        ),
      ).toMatchObject({
        id: orderId,
        externalOrderId: 'ref:e2e-7001',
        verificationId: message.verificationId,
        verificationStatus: 'confirmed',
      });
      await expectReconciled(store.orgId, { orders: 1, sent: 1 });
    });
  });
});
