import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validateOrReject } from 'class-validator';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ImportManifest } from '../scripts/order-import-fixtures/build-fixtures';
import {
  creditLedgerEntries,
  integrations,
  memberships,
  creditReservations,
  orderImportRows,
  orders,
  verificationMessageDispatches,
  verifications,
  webhookEvents,
} from '../src/infrastructure/database/schema';
import { CreateManualOrderDto } from '../src/modules/orders/dto/create-manual-order.dto';
import { StandaloneOrderIngestionService } from '../src/modules/order-ingestion/standalone-order-ingestion.service';
import { OrderImportReleaseTickService } from '../src/modules/order-imports/release/order-import-release-tick.service';
import { IMPORT_FIELDS } from '../src/modules/order-imports/mapping/alias-dictionary';
import { normalizePaymentValue } from '../src/modules/order-imports/mapping/payment-value-classifier';
import {
  releaseGateConfig,
  releaseGateHarness,
  type ReleaseGateHarness,
} from './contracts/release-gate-harness';

const FIXTURES = resolve(__dirname, 'fixtures/order-imports');
const ATTESTATION = 'bulk-import-consent-v1';

const gate = releaseGateHarness();
type Merchant = Awaited<ReturnType<ReleaseGateHarness['merchant']>>;

function manifestOf(file: string): ImportManifest {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${file}.manifest.json`), 'utf8'),
  ) as ImportManifest;
}

/** The mapping body the wizard's Save sends for a manifest. */
function mappingBody(manifest: ImportManifest) {
  const mapping: Record<string, unknown> = Object.fromEntries(
    IMPORT_FIELDS.map((field) => [field, manifest.mapping?.[field] ?? null]),
  );
  mapping.customerName = manifest.mapping?.customerName ?? [];
  return {
    mapping,
    options: {
      country: manifest.country,
      defaultCurrency: manifest.defaultCurrency,
      dateFormat: manifest.dateFormat ?? 'auto',
      paymentValueMap: Object.fromEntries(
        Object.entries(manifest.paymentValueMap ?? {}).map(([value, kind]) => [
          normalizePaymentValue(value),
          kind,
        ]),
      ),
    },
  } as never;
}

/**
 * The merchant's steps through the real services, recording each answer the
 * controller would return (the controllers are one call each), so the
 * Playwright flow replays exactly what this backend answered.
 */
class MerchantSession {
  readonly recording: { step: string; body: unknown }[] = [];
  batchId = '';

  constructor(readonly merchant: Merchant) {}

  private record<T>(step: string, body: T): T {
    this.recording.push({ step, body: JSON.parse(JSON.stringify(body)) });
    return body;
  }

  async upload(file: string, bytes = readFileSync(join(FIXTURES, file))) {
    const uploaded = await gate.services.uploads.upload(
      this.merchant.user,
      this.merchant.source,
      { buffer: bytes, size: bytes.length, originalname: file },
    );
    this.batchId = uploaded.batchId;
    return this.record('upload', uploaded);
  }

  async map(manifest: ImportManifest) {
    const saved = await gate.services.mapping.save(
      this.merchant.user,
      this.merchant.source,
      this.batchId,
      mappingBody(manifest),
    );
    // Re-judge on the manifest's clock so date-window outcomes don't depend
    // on the day the suite runs; everything else is exactly what Save did.
    await gate.services.validation.validateBatch(
      { orgId: this.merchant.orgId, source: this.merchant.source },
      this.batchId,
      new Date(manifest.now),
    );
    return this.record('mapping', saved);
  }

  async detail(step: string) {
    return this.record(
      step,
      await gate.services.detail.detail(this.merchant.user, this.batchId),
    );
  }

  async review() {
    for (const outcome of ['ready', 'invalid', 'duplicate', 'excluded'])
      this.record(
        `rows:${outcome}`,
        await gate.services.rows.list(this.merchant.user, this.batchId, {
          outcome,
          limit: 100,
        } as never),
      );
  }

  async commit(key = `commit-${this.batchId}`) {
    const answer = await gate.services.commits.commit(
      this.merchant.user,
      this.merchant.source,
      this.batchId,
      key,
    );
    this.record('commit', answer);
    for (const job of gate.commitJobs.splice(0))
      await gate.services.commitProcessor.process({ data: job } as Job<{
        batchId: string;
        orgId: string;
      }>);
    return answer;
  }

  async start() {
    const quote = this.record(
      'start-quote',
      await gate.services.starts.quote(
        this.merchant.user,
        this.merchant.source,
        this.batchId,
      ),
    );
    const started = await gate.services.starts.start(
      this.merchant.user,
      this.merchant.source,
      this.batchId,
      `start-${this.batchId}`,
      { attestationVersion: ATTESTATION, quoteToken: quote.quoteToken },
    );
    this.record('start', started);
    return quote;
  }

  /** Ticks the org's release job and runs what it dispatched, until done. */
  async releaseAll(maxTicks = 20, tick = gate.services.ticks) {
    for (let attempt = 0; attempt < maxTicks; attempt++) {
      await tick.tick(this.merchant.orgId);
      await gate.drain();
      const [batch] = await gate.client<{ status: string }[]>`
        SELECT status FROM order_import_batches WHERE id = ${this.batchId}`;
      if (batch.status !== 'releasing') return batch.status;
    }
    throw new Error('release did not finish');
  }

  async verificationsList(step: string) {
    return this.record(
      step,
      await gate.services.verifications.listByOrg(this.merchant.orgId, {
        importBatchId: this.batchId,
        limit: 100,
      } as never),
    );
  }

  /** Row number → the order it became. */
  async importedRows(): Promise<Map<number, string>> {
    const rows = await gate.db
      .select({
        rowNumber: orderImportRows.rowNumber,
        orderId: orderImportRows.orderId,
      })
      .from(orderImportRows)
      .where(eq(orderImportRows.batchId, this.batchId));
    return new Map(
      rows
        .filter((row) => row.orderId)
        .map((row) => [row.rowNumber, row.orderId!]),
    );
  }
}

async function orgCounts(orgId: string) {
  const [dispatchRows, reservationRows, verificationRows] = await Promise.all([
    gate.db
      .select({ id: verificationMessageDispatches.id })
      .from(verificationMessageDispatches)
      .where(eq(verificationMessageDispatches.orgId, orgId)),
    gate.db
      .select({ id: creditReservations.id })
      .from(creditReservations)
      .where(eq(creditReservations.orgId, orgId)),
    gate.db
      .select({ id: verifications.id })
      .from(verifications)
      .where(eq(verifications.orgId, orgId)),
  ]);
  return {
    dispatches: dispatchRows.length,
    reservations: reservationRows.length,
    verifications: verificationRows.length,
  };
}

async function verificationOf(orderId: string) {
  const [row] = await gate.db
    .select()
    .from(verifications)
    .where(eq(verifications.orderId, orderId));
  return row;
}

function sendsTo(orderIds: string[], verificationIds: Set<string>) {
  void orderIds;
  return gate.sends.filter((send) => verificationIds.has(send.verificationId));
}

describe('E04.6 release gate PostgreSQL contract (US-04.6-10)', () => {
  beforeAll(() => gate.setup());
  afterAll(() => gate.teardown());

  /**
   * AC2: a merchant's Arabic workbook from upload to the customer's replies,
   * through every real service over PostgreSQL. Nothing is sent before start;
   * afterwards each ready row is one WhatsApp message, and the Verifications
   * list for the batch ends exactly as the fixture's manifest says.
   */
  it('AC2 end to end: arabic-excel.xlsx upload → map → review → commit → start → release → replies → Verifications match the manifest', async () => {
    const manifest = manifestOf('arabic-excel.xlsx');
    const merchant = await gate.merchant();
    const session = new MerchantSession(merchant);
    const sendsBefore = gate.sends.length;

    const uploaded = await session.upload('arabic-excel.xlsx');
    expect(uploaded).toMatchObject({ status: 'draft', rowCount: 8 });
    await session.detail('detail:uploaded');
    await session.map(manifest);
    await session.detail('detail:reviewed');
    await session.review();

    const judged = await gate.db
      .select()
      .from(orderImportRows)
      .where(eq(orderImportRows.batchId, session.batchId))
      .orderBy(asc(orderImportRows.rowNumber));
    expect(
      judged.map((row) => ({
        rowNumber: row.rowNumber,
        outcome: row.outcome,
        issues: ((row.issues as { code: string }[]) ?? [])
          .map((issue) => issue.code)
          .sort(),
      })),
    ).toEqual(
      manifest.rows!.map((row) => ({
        rowNumber: row.rowNumber,
        outcome: row.outcome,
        issues: [...row.issues].sort(),
      })),
    );

    await session.commit();
    await session.detail('detail:awaiting_start');
    const imported = await session.importedRows();
    const ready = manifest
      .rows!.filter((row) => row.outcome === 'ready')
      .map((row) => row.rowNumber);
    expect([...imported.keys()].sort((a, b) => a - b)).toEqual(ready);

    // Zero contact before start: no message, dispatch, credit hold or
    // verification exists, and every order shows as awaiting start.
    expect(gate.sends.length).toBe(sendsBefore);
    expect(await orgCounts(merchant.orgId)).toEqual({
      dispatches: 0,
      reservations: 0,
      verifications: 0,
    });
    const held = await session.verificationsList('verifications:held');
    expect(held.data.map((row) => row.status)).toEqual(
      ready.map(() => 'awaiting_start'),
    );

    const quote = await session.start();
    expect(quote.orders).toBe(ready.length);
    expect(await session.releaseAll()).toBe('completed');
    await session.detail('detail:completed');

    // One message per imported order, to the normalized phone.
    const byRow = new Map<
      number,
      { orderId: string; verificationId: string }
    >();
    for (const [rowNumber, orderId] of imported) {
      const verification = await verificationOf(orderId);
      byRow.set(rowNumber, { orderId, verificationId: verification.id });
    }
    const verificationIds = new Set(
      [...byRow.values()].map((row) => row.verificationId),
    );
    const sent = sendsTo([...imported.values()], verificationIds);
    expect(sent).toHaveLength(ready.length);
    for (const rowNumber of ready) {
      const want = manifest.rows!.find((row) => row.rowNumber === rowNumber)!;
      const message = sent.find(
        (send) => send.verificationId === byRow.get(rowNumber)!.verificationId,
      )!;
      if (want.normalized?.customerPhone)
        expect(message.to).toBe(want.normalized.customerPhone);
    }

    for (const [rowNumber, action] of Object.entries(
      manifest.results!.replies,
    )) {
      if (action === 'none') continue;
      const row = byRow.get(Number(rowNumber))!;
      const message = sent.find(
        (send) => send.verificationId === row.verificationId,
      )!;
      await gate.reply(row.verificationId, message.to, action);
    }

    const results = await session.verificationsList('verifications:results');
    const statusByOrder = new Map(
      results.data.map((row) => [row.order_id, row.status]),
    );
    expect(
      Object.fromEntries(
        [...byRow].map(([rowNumber, row]) => [
          rowNumber,
          statusByOrder.get(row.orderId),
        ]),
      ),
    ).toEqual(manifest.results!.status);
    // Rows that were never imported never reach Verifications.
    expect(results.data).toHaveLength(ready.length);

    if (process.env.RECORD_E2E === '1') {
      const out = resolve(FIXTURES, 'e2e');
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, 'arabic-excel.recording.json'),
        `${JSON.stringify(
          {
            file: 'arabic-excel.xlsx',
            batchId: session.batchId,
            steps: session.recording,
          },
          null,
          2,
        )}\n`,
      );
    }
  });

  describe('AC3 equivalence: the same order through the manual form and through import', () => {
    const ORDER = {
      phone: '+201055500001',
      name: 'Equal Customer',
      amount: '640.00',
      reference: 'EQ-1',
    };

    /** Everything the core produced for one order, ids and clocks removed. */
    async function snapshot(orgId: string, orderId: string) {
      const verification = await verificationOf(orderId);
      const [order] = await gate.db
        .select()
        .from(orders)
        .where(eq(orders.id, orderId));
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
      const dashboard = await gate.repositories.orders.findDashboardOrderById(
        orderId,
        orgId,
      );
      const sentAt = verification.lastSentAt
        ? new Date(verification.lastSentAt).getTime()
        : 0;
      const at = (value: unknown) => (value ? 'set' : null);
      return {
        order: {
          orderNumber: order.orderNumber,
          customerPhone: order.customerPhone,
          customerName: order.customerName,
          totalPrice: order.totalPrice,
          currency: order.currency,
          paymentMethod: order.paymentMethod,
          isTest: order.isTest,
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
        dispatches: dispatchRows.map((row) => ({
          kind: row.kind,
          state: row.state,
          accountingMode: row.accountingMode,
          templateName: row.templateName,
        })),
        credit: {
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
        automation: gate.automationJobs
          .filter((job) => job.verificationId === verification.id)
          .map((job) => ({
            kind: job.kind,
            minutesAfterSend: Math.round(
              (job.dueAt.getTime() - sentAt) / 60_000,
            ),
          })),
        dashboard: dashboard
          ? {
              status: dashboard.retryGuardStatus,
              reason: dashboard.retryGuardReason,
              retryable: dashboard.retryGuardRetryable,
              verificationStatus: dashboard.verificationStatus,
            }
          : null,
      };
    }

    async function manualOrder(merchant: Merchant, suffix: string) {
      // What the manual form posts, through the DTO transforms and checks the
      // app-wide ValidationPipe applies before the controller.
      const body = plainToInstance(CreateManualOrderDto, {
        customerPhone: ORDER.phone,
        customerName: ORDER.name,
        orderNumber: `${ORDER.reference}-${suffix}`,
        totalPrice: ORDER.amount,
        currency: 'EGP',
        paymentMethod: 'cash_on_delivery',
      });
      await validateOrReject(body);
      const created = await gate.services.orders.createManualOrder(
        merchant.user,
        `equivalence-manual-${suffix}-${randomUUID()}`,
        body,
      );
      await gate.drain();
      return created.orderId;
    }

    async function importedOrder(merchant: Merchant, suffix: string) {
      const csv = [
        'Order Number,Customer Name,Phone,Amount,Payment Method',
        `${ORDER.reference}-${suffix},${ORDER.name},${ORDER.phone},${ORDER.amount},COD`,
      ].join('\r\n');
      const session = new MerchantSession(merchant);
      await session.upload(`equivalence-${suffix}.csv`, Buffer.from(csv));
      await gate.services.mapping.save(
        merchant.user,
        merchant.source,
        session.batchId,
        mappingBody({
          now: new Date().toISOString(),
          timezone: 'Africa/Cairo',
          country: 'EG',
          defaultCurrency: 'EGP',
          assumeCodWhenPaymentMissing: false,
          mapping: {
            orderReference: 'Order Number',
            customerName: ['Customer Name'],
            phone: 'Phone',
            amount: 'Amount',
            paymentMethod: 'Payment Method',
          },
        }),
      );
      await session.commit();
      await session.start();
      expect(await session.releaseAll()).toBe('completed');
      const [orderId] = [...(await session.importedRows()).values()];
      return orderId;
    }

    /**
     * Two merchants with identical settings and balances: one creates the
     * order by hand, the other imports it. Each then lives the same life,
     * snapshotted after the send, after the customer's action and after the
     * automation jobs.
     */
    async function both(suffix: string) {
      const manual = await gate.merchant();
      const imported = await gate.merchant();
      return {
        manual: {
          merchant: manual,
          orderId: await manualOrder(manual, suffix),
        },
        imported: {
          merchant: imported,
          orderId: await importedOrder(imported, suffix),
        },
      };
    }

    it('confirm: identical verification, dispatch kinds, credit, automation jobs and lifecycle', async () => {
      const pair = await both('confirm');
      const stages: Record<string, unknown[]> = { manual: [], imported: [] };
      for (const side of ['manual', 'imported'] as const)
        stages[side].push(
          await snapshot(pair[side].merchant.orgId, pair[side].orderId),
        );
      for (const side of ['manual', 'imported'] as const) {
        const verification = await verificationOf(pair[side].orderId);
        await gate.reply(verification.id, ORDER.phone, 'confirm');
        stages[side].push(
          await snapshot(pair[side].merchant.orgId, pair[side].orderId),
        );
      }
      expect(stages.imported).toEqual(stages.manual);
      expect(stages.manual[1]).toMatchObject({
        verification: { status: 'confirmed' },
        dispatches: [{ kind: 'initial' }],
      });
    });

    it('no reply: identical follow-up, no-reply escalation, credit and lifecycle', async () => {
      const pair = await both('noreply');
      const stages: Record<string, unknown[]> = { manual: [], imported: [] };
      for (const side of ['manual', 'imported'] as const) {
        const { orgId } = pair[side].merchant;
        const verification = await verificationOf(pair[side].orderId);
        stages[side].push(await snapshot(orgId, pair[side].orderId));
        for (const kind of ['follow_up', 'no_reply'] as const) {
          const job = gate.automationJobs.find(
            (candidate) =>
              candidate.verificationId === verification.id &&
              candidate.kind === kind,
          )!;
          await gate.runAutomation(job);
          stages[side].push(await snapshot(orgId, pair[side].orderId));
        }
      }
      expect(stages.imported).toEqual(stages.manual);
      expect(stages.manual[2]).toMatchObject({
        verification: { status: 'no_reply' },
        dispatches: [{ kind: 'initial' }, { kind: 'follow_up' }],
      });
    });

    it('differs only in the envelope metadata an audit reads', async () => {
      const pair = await both('envelope');
      const payloadOf = async (orderId: string) => {
        const [event] = await gate.db
          .select()
          .from(webhookEvents)
          .where(eq(webhookEvents.orderId, orderId));
        return event.rawPayload as Record<string, unknown>;
      };
      const manual = await payloadOf(pair.manual.orderId);
      const imported = await payloadOf(pair.imported.orderId);
      // The only keys allowed to differ between the two envelopes: the
      // channel, the import's audit metadata, and the fingerprint over the
      // order identity (epic 'Order identity': manual-<hash> vs ref:<key>).
      const ALLOWED = new Set([
        'ingestionType',
        'importBatchId',
        'importRowNumber',
        'submissionFingerprint',
        'order',
      ]);
      const keys = new Set([...Object.keys(manual), ...Object.keys(imported)]);
      const differing = [...keys].filter(
        (key) => JSON.stringify(manual[key]) !== JSON.stringify(imported[key]),
      );
      expect(differing.filter((key) => !ALLOWED.has(key))).toEqual([]);
      expect(manual.ingestionType).toBe('manual');
      expect(imported.ingestionType).toBe('bulk_import');
      // Inside the order only its identity differs; every field the core
      // reads is the same.
      const { externalOrderId: manualId, ...manualOrder } =
        manual.order as Record<string, unknown>;
      const { externalOrderId: importedId, ...importedOrder } =
        imported.order as Record<string, unknown>;
      expect(importedOrder).toEqual(manualOrder);
      expect(manualId).toMatch(/^manual-[0-9a-f]{40}$/);
      expect(importedId).toBe('ref:eq-1-envelope');
    });
  });

  describe('AC4 concurrency: at most one order per reference, one dispatch per event, zero billing for withdrawn events', () => {
    const csvOf = (references: string[], phonePrefix = '0101777') =>
      [
        'Order Number,Customer Name,Phone,Amount,Payment Method',
        ...references.map(
          (reference, index) =>
            `${reference},Customer ${index},${phonePrefix}${String(1000 + index)},300,COD`,
        ),
      ].join('\r\n');
    const BASIC_MAPPING: ImportManifest = {
      now: new Date().toISOString(),
      timezone: 'Africa/Cairo',
      country: 'EG',
      defaultCurrency: 'EGP',
      assumeCodWhenPaymentMissing: false,
      mapping: {
        orderReference: 'Order Number',
        customerName: ['Customer Name'],
        phone: 'Phone',
        amount: 'Amount',
        paymentMethod: 'Payment Method',
      },
    };

    async function draft(
      merchant: Merchant,
      references: string[],
      prefix?: string,
    ) {
      const session = new MerchantSession(merchant);
      await session.upload(
        `concurrency-${randomUUID()}.csv`,
        Buffer.from(csvOf(references, prefix)),
      );
      await gate.services.mapping.save(
        merchant.user,
        merchant.source,
        session.batchId,
        mappingBody(BASIC_MAPPING),
      );
      return session;
    }

    async function eventsOf(batchId: string) {
      return gate.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.holdGroupId, batchId));
    }

    /** Dispatch ledger rows and credit reservations for a set of orders. */
    async function billingOf(orderIds: string[]) {
      if (orderIds.length === 0) return { dispatches: 0, reservations: 0 };
      const verificationRows = await gate.db
        .select({ id: verifications.id })
        .from(verifications)
        .where(inArray(verifications.orderId, orderIds));
      const ids = verificationRows.map((row) => row.id);
      if (ids.length === 0) return { dispatches: 0, reservations: 0 };
      const [dispatchRows, reservationRows] = await Promise.all([
        gate.db
          .select({ id: verificationMessageDispatches.id })
          .from(verificationMessageDispatches)
          .where(inArray(verificationMessageDispatches.verificationId, ids)),
        gate.db
          .select({ id: creditReservations.id })
          .from(creditReservations)
          .where(inArray(creditReservations.verificationId, ids)),
      ]);
      return {
        dispatches: dispatchRows.length,
        reservations: reservationRows.length,
      };
    }

    it('double commit: two tabs with different keys create each order once', async () => {
      const merchant = await gate.merchant();
      const session = await draft(merchant, ['DC-1', 'DC-2', 'DC-3']);
      const outcomes = await Promise.allSettled([
        gate.services.commits.commit(
          merchant.user,
          merchant.source,
          session.batchId,
          `tab-a-${session.batchId}`,
        ),
        gate.services.commits.commit(
          merchant.user,
          merchant.source,
          session.batchId,
          `tab-b-${session.batchId}`,
        ),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(
        (outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult)
          .reason,
      ).toMatchObject({
        response: { code: 'IMPORT_BATCH_STATE_CONFLICT' },
      });
      // The same key replays; a double-click enqueues the one job once.
      const winner = outcomes.findIndex((o) => o.status === 'fulfilled');
      const key = `${winner === 0 ? 'tab-a' : 'tab-b'}-${session.batchId}`;
      await gate.services.commits.commit(
        merchant.user,
        merchant.source,
        session.batchId,
        key,
      );
      const jobs = gate.commitJobs.splice(0);
      for (const job of jobs)
        await gate.services.commitProcessor.process({ data: job } as Job<{
          batchId: string;
          orgId: string;
        }>);
      // Re-running the job (a BullMQ retry) creates nothing more.
      await gate.services.commitProcessor.process({ data: jobs[0] } as Job<{
        batchId: string;
        orgId: string;
      }>);
      const created = await gate.db
        .select({ id: orders.id, externalOrderId: orders.externalOrderId })
        .from(orders)
        .where(eq(orders.orgId, merchant.orgId));
      expect(created.map((order) => order.externalOrderId).sort()).toEqual([
        'ref:dc-1',
        'ref:dc-2',
        'ref:dc-3',
      ]);
      const events = await eventsOf(session.batchId);
      expect(events).toHaveLength(3);
      // Committing holds; nothing was dispatched.
      expect(
        gate.dispatchedIds.filter((id) =>
          events.some((event) => event.id === id),
        ),
      ).toEqual([]);
      expect(events.every((event) => event.holdState === 'held')).toBe(true);
    });

    it('two batches with overlapping references: one order per reference, the loser row is ALREADY_IMPORTED with no orphan event', async () => {
      const merchant = await gate.merchant();
      const first = await draft(merchant, ['OV-1', 'OV-2', 'OV-3']);
      const second = await draft(merchant, ['OV-2', 'OV-3', 'OV-4'], '0101888');
      await Promise.all([first.commit(), second.commit()]);

      const created = await gate.db
        .select({ externalOrderId: orders.externalOrderId })
        .from(orders)
        .where(eq(orders.orgId, merchant.orgId));
      expect(created.map((order) => order.externalOrderId).sort()).toEqual([
        'ref:ov-1',
        'ref:ov-2',
        'ref:ov-3',
        'ref:ov-4',
      ]);
      const rows = await gate.db
        .select()
        .from(orderImportRows)
        .where(
          inArray(orderImportRows.batchId, [first.batchId, second.batchId]),
        );
      const outcomes = rows.map((row) => row.outcome);
      expect(outcomes.filter((o) => o === 'imported')).toHaveLength(4);
      const losers = rows.filter((row) => row.outcome === 'duplicate');
      expect(losers).toHaveLength(2);
      for (const loser of losers)
        expect(
          (loser.issues as { code: string }[]).map((i) => i.code),
        ).toContain('ALREADY_IMPORTED');
      const events = [
        ...(await eventsOf(first.batchId)),
        ...(await eventsOf(second.batchId)),
      ];
      expect(events).toHaveLength(4);
      expect(events.every((event) => event.orderId)).toBe(true);
    });

    it('stop against a release tick: every event is released or withdrawn, never both, and withdrawn ones cost nothing', async () => {
      const merchant = await gate.merchant();
      const references = Array.from({ length: 12 }, (_, i) => `ST-${i + 1}`);
      const session = await draft(merchant, references);
      await session.commit();
      await session.start();
      await Promise.all([
        gate.services.ticks.tick(merchant.orgId),
        gate.services.starts.stop(
          merchant.user,
          merchant.source,
          session.batchId,
        ),
      ]);
      await gate.drain();

      const events = await eventsOf(session.batchId);
      expect(events).toHaveLength(12);
      expect(
        events.every((event) =>
          ['released', 'withdrawn'].includes(event.holdState),
        ),
      ).toBe(true);
      const withdrawn = events.filter(
        (event) => event.holdState === 'withdrawn',
      );
      const released = events.filter((event) => event.holdState === 'released');
      expect(await billingOf(withdrawn.map((event) => event.orderId!))).toEqual(
        {
          dispatches: 0,
          reservations: 0,
        },
      );
      // A released event was sent at most once.
      const billed = await billingOf(released.map((event) => event.orderId!));
      expect(billed.dispatches).toBe(released.length);
      expect(new Set(gate.dispatchedIds).size).toBe(gate.dispatchedIds.length);
    });

    it('a balance drop during release: dispatch never outruns credit, the batch auto-pauses and the rest stay held and unbilled', async () => {
      const merchant = await gate.merchant({ credits: 6 });
      // One released order per tick, so the drop lands mid-release.
      const slow = new OrderImportReleaseTickService(
        gate.repositories.releases,
        gate.repositories.integrations,
        gate.services.readiness,
        gate.repositories.events,
        gate.services.dispatcher,
        gate.scheduler as never,
        releaseGateConfig({
          BULK_IMPORT_RELEASE_PER_MINUTE: '2',
        }),
      );
      const references = Array.from({ length: 6 }, (_, i) => `BD-${i + 1}`);
      const session = await draft(merchant, references);
      await session.commit();
      await session.start();
      await slow.tick(merchant.orgId);
      await gate.drain();

      // Staff take back five credits: one left for six orders.
      await gate.db.transaction(async (tx) => {
        const account = await gate.repositories.credits.lockAccount(
          tx,
          merchant.orgId,
        );
        const summary = await gate.repositories.credits.getSummary(
          merchant.orgId,
        );
        await gate.repositories.credits.insertLedgerEntry(tx, {
          orgId: merchant.orgId,
          type: 'staff_adjustment',
          quantity: -summary!.availableCredits,
          idempotencyKey: `gate-drop:${merchant.orgId}`,
          actorId: randomUUID(),
          reason: 'Release gate balance drop',
          postedBalanceBefore: summary!.postedBalance,
          postedBalanceAfter:
            summary!.postedBalance - summary!.availableCredits,
        });
        await gate.repositories.credits.updateProjection(tx, {
          orgId: merchant.orgId,
          expectedVersion: account.version,
          postedBalance: summary!.postedBalance - summary!.availableCredits,
          heldCredits: summary!.heldCredits,
          status: 'active',
        });
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        await slow.tick(merchant.orgId);
        await gate.drain();
      }

      const [batch] = await gate.client<
        { status: string; paused_reason: string }[]
      >`
        SELECT status, paused_reason FROM order_import_batches WHERE id = ${session.batchId}`;
      expect(batch).toEqual({
        status: 'paused',
        paused_reason: 'INSUFFICIENT_CREDITS',
      });
      const events = await eventsOf(session.batchId);
      const stillHeld = events.filter((event) => event.holdState === 'held');
      const released = events.filter((event) => event.holdState === 'released');
      // One released (and billed) before the drop; the other five held.
      expect({ released: released.length, held: stillHeld.length }).toEqual({
        released: 1,
        held: 5,
      });
      expect(await billingOf(released.map((event) => event.orderId!))).toEqual({
        dispatches: 1,
        reservations: 1,
      });
      expect(await billingOf(stillHeld.map((event) => event.orderId!))).toEqual(
        {
          dispatches: 0,
          reservations: 0,
        },
      );
      const summary = await gate.repositories.credits.getSummary(
        merchant.orgId,
      );
      expect(summary!.postedBalance).toBeGreaterThanOrEqual(0);

      // Stop now: the held ones are withdrawn and never billed.
      await gate.services.starts.stop(
        merchant.user,
        merchant.source,
        session.batchId,
      );
      expect(
        await billingOf(
          (await eventsOf(session.batchId))
            .filter((event) => event.holdState === 'withdrawn')
            .map((event) => event.orderId!),
        ),
      ).toEqual({ dispatches: 0, reservations: 0 });
    });

    it('a worker kill during release: the recovery sweep dispatches the released events exactly once', async () => {
      const merchant = await gate.merchant();
      const references = Array.from({ length: 3 }, (_, i) => `WK-${i + 1}`);
      const session = await draft(merchant, references);
      await session.commit();
      await session.start();
      // The worker dies after releaseHeld committed and before any dispatch.
      const dying = new OrderImportReleaseTickService(
        gate.repositories.releases,
        gate.repositories.integrations,
        gate.services.readiness,
        gate.repositories.events,
        {
          dispatchById: () => Promise.reject(new Error('worker killed')),
        } as never,
        gate.scheduler as never,
        gate.config,
      );
      await dying.tick(merchant.orgId).catch(() => undefined);
      const released = (await eventsOf(session.batchId)).filter(
        (event) => event.holdState === 'released',
      );
      expect(released).toHaveLength(3);

      await gate.services.reconciler.reconcileOnce();
      await gate.drain();
      await gate.services.reconciler.reconcileOnce();
      await gate.drain();

      const ids = released.map((event) => event.id);
      expect(
        gate.dispatchedIds.filter((id) => ids.includes(id)).sort(),
      ).toEqual([...ids].sort());
      expect(await billingOf(released.map((event) => event.orderId!))).toEqual({
        dispatches: 3,
        reservations: 3,
      });
    });

    it('a worker kill during commit: re-running the job links what exists and creates nothing twice', async () => {
      const merchant = await gate.merchant();
      // A file's row limit (100) fits one acceptance chunk.
      const references = Array.from({ length: 100 }, (_, i) => `CK-${i + 1}`);
      const session = await draft(merchant, references);
      await gate.services.commits.commit(
        merchant.user,
        merchant.source,
        session.batchId,
        `commit-${session.batchId}`,
      );
      const [job] = gate.commitJobs.splice(0);
      // The chunk lands; the process dies before the rows are marked imported.
      const ingestion = gate.services.ingestion;
      const acceptMany = (
        ...args: Parameters<typeof ingestion.acceptMany>
      ): ReturnType<typeof ingestion.acceptMany> =>
        StandaloneOrderIngestionService.prototype.acceptMany.apply(
          ingestion,
          args,
        ) as ReturnType<typeof ingestion.acceptMany>;
      const spy = jest
        .spyOn(gate.services.ingestion, 'acceptMany')
        .mockImplementationOnce(async (...args) => {
          await acceptMany(...args);
          throw new Error('worker killed');
        });
      await expect(
        gate.services.commitProcessor.process({ data: job } as Job<{
          batchId: string;
          orgId: string;
        }>),
      ).rejects.toThrow('worker killed');
      spy.mockRestore();
      await gate.services.commitProcessor.process({ data: job } as Job<{
        batchId: string;
        orgId: string;
      }>);

      const created = await gate.db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.orgId, merchant.orgId));
      expect(created).toHaveLength(100);
      expect(await eventsOf(session.batchId)).toHaveLength(100);
      const rows = await gate.db
        .select()
        .from(orderImportRows)
        .where(
          and(
            eq(orderImportRows.batchId, session.batchId),
            eq(orderImportRows.outcome, 'imported'),
          ),
        );
      expect(rows).toHaveLength(100);
      expect(await orgCounts(merchant.orgId)).toMatchObject({
        dispatches: 0,
        reservations: 0,
      });
    });
  });

  /**
   * Edge-case catalogue entries the per-story suites did not exercise over
   * PostgreSQL with the real pipeline (US-04.6-10 traceability table).
   */
  describe('edge-case catalogue gaps closed by the gate', () => {
    const MAPPING: ImportManifest = {
      now: new Date().toISOString(),
      timezone: 'Africa/Cairo',
      country: 'EG',
      defaultCurrency: 'EGP',
      assumeCodWhenPaymentMissing: false,
      mapping: {
        orderReference: 'Order Number',
        customerName: ['Customer Name'],
        phone: 'Phone',
        amount: 'Amount',
        paymentMethod: 'Payment Method',
      },
    };
    const HEADER = 'Order Number,Customer Name,Phone,Amount,Payment Method';

    async function uploadAndMap(
      merchant: Merchant,
      csv: string,
      name = `gap-${randomUUID()}.csv`,
      manifest: ImportManifest = MAPPING,
    ) {
      const session = new MerchantSession(merchant);
      const uploaded = await session.upload(name, Buffer.from(csv));
      await gate.services.mapping.save(
        merchant.user,
        merchant.source,
        session.batchId,
        mappingBody(manifest),
      );
      return { session, uploaded };
    }

    async function rowsOf(batchId: string) {
      const rows = await gate.db
        .select()
        .from(orderImportRows)
        .where(eq(orderImportRows.batchId, batchId))
        .orderBy(asc(orderImportRows.rowNumber));
      return rows.map((row) => ({
        rowNumber: row.rowNumber,
        outcome: row.outcome,
        issues: ((row.issues as { code: string }[]) ?? []).map((i) => i.code),
      }));
    }

    async function batchState(batchId: string) {
      const [row] = await gate.client<
        {
          status: string;
          paused_reason: string | null;
          attested_by: string | null;
        }[]
      >`SELECT status, paused_reason, attested_by FROM order_import_batches WHERE id = ${batchId}`;
      return row;
    }

    it('the same file uploaded again after its import: L0 warns and L1 marks every referenced row as already imported', async () => {
      const merchant = await gate.merchant();
      const csv = [
        HEADER,
        'SF-1,Aya Samir,01012300001,300,COD',
        'SF-2,Badr Omar,01012300002,450,COD',
      ].join('\r\n');
      const first = await uploadAndMap(merchant, csv, 'same-file.csv');
      await first.session.commit();

      const again = await uploadAndMap(merchant, csv, 'same-file.csv');
      expect(again.uploaded.duplicateFileOf).toMatchObject({
        batchId: first.session.batchId,
      });
      expect(await rowsOf(again.session.batchId)).toEqual([
        { rowNumber: 2, outcome: 'duplicate', issues: ['ALREADY_IMPORTED'] },
        { rowNumber: 3, outcome: 'duplicate', issues: ['ALREADY_IMPORTED'] },
      ]);
    });

    it('a corrected file uploaded after fixing the reported rows: only the fixed rows import', async () => {
      const merchant = await gate.merchant();
      const first = await uploadAndMap(
        merchant,
        [
          HEADER,
          'FX-1,Dina Adel,01012300011,300,COD',
          'FX-2,Emad Fawzy,0223456789,300,COD',
          'FX-3,Farah Nabil,01012300013,abc,COD',
        ].join('\r\n'),
      );
      expect(
        (await rowsOf(first.session.batchId)).map((row) => row.outcome),
      ).toEqual(['ready', 'invalid', 'invalid']);
      await first.session.commit();

      // The merchant fixes the two rows and re-uploads the whole file.
      const fixed = await uploadAndMap(
        merchant,
        [
          HEADER,
          'FX-1,Dina Adel,01012300011,300,COD',
          'FX-2,Emad Fawzy,01012300012,300,COD',
          'FX-3,Farah Nabil,01012300013,300,COD',
        ].join('\r\n'),
      );
      expect(await rowsOf(fixed.session.batchId)).toEqual([
        { rowNumber: 2, outcome: 'duplicate', issues: ['ALREADY_IMPORTED'] },
        { rowNumber: 3, outcome: 'ready', issues: [] },
        { rowNumber: 4, outcome: 'ready', issues: [] },
      ]);
      await fixed.session.commit();
      expect([...(await fixed.session.importedRows()).keys()].sort()).toEqual([
        3, 4,
      ]);
    });

    it('a reference-less file uploaded again later: L3 holds the repeats back as possible duplicates, and the merchant can include a genuine repeat order', async () => {
      const merchant = await gate.merchant();
      const csv = readFileSync(join(FIXTURES, 'no-reference.csv'));
      const manifest = manifestOf('no-reference.csv');
      const first = new MerchantSession(merchant);
      await first.upload('no-reference.csv', csv);
      await first.map(manifest);
      await first.commit();

      const again = new MerchantSession(merchant);
      await again.upload('no-reference.csv', csv);
      await gate.services.mapping.save(
        merchant.user,
        merchant.source,
        again.batchId,
        mappingBody(manifest),
      );
      // Judged on the manifest's clock, like the first upload: row 4's date
      // must not age past the order window on the day the suite runs.
      await gate.services.validation.validateBatch(
        { orgId: merchant.orgId, source: merchant.source },
        again.batchId,
        new Date(manifest.now),
      );
      const rows = await rowsOf(again.batchId);
      const held = rows.filter((row) => row.outcome === 'ready');
      expect(held).toEqual([]);
      const possible = rows.filter((row) =>
        row.issues.includes('POSSIBLE_DUPLICATE'),
      );
      expect(possible.map((row) => row.rowNumber)).toEqual([2, 4, 5]);

      // The same customer really ordered twice: include it anyway.
      const included = await gate.services.rows.setInclude(
        merchant.user,
        again.batchId,
        5,
        true,
      );
      expect(included.row).toMatchObject({ rowNumber: 5, outcome: 'ready' });
    });

    it('a manual order later present in an export: L3 matches it by order number across channels', async () => {
      const merchant = await gate.merchant();
      const body = plainToInstance(CreateManualOrderDto, {
        customerPhone: '+201012300021',
        customerName: 'Ghada Lotfy',
        orderNumber: 'MX-77',
        totalPrice: '520.00',
        currency: 'EGP',
        paymentMethod: 'cash_on_delivery',
      });
      await validateOrReject(body);
      await gate.services.orders.createManualOrder(
        merchant.user,
        `gap-manual-${randomUUID()}`,
        body,
      );
      await gate.drain();

      const imported = await uploadAndMap(
        merchant,
        [HEADER, 'mx-77,Ghada L.,01099988800,999,COD'].join('\r\n'),
      );
      const [row] = await rowsOf(imported.session.batchId);
      expect(row).toEqual({
        rowNumber: 2,
        outcome: 'excluded',
        issues: ['POSSIBLE_DUPLICATE'],
      });
    });

    it.each([
      ['onboarding is reset', { onboardingStatus: 'pending' }],
      ['the source is deactivated', { isActive: false }],
    ])(
      'auto-pauses a releasing batch when %s, and releases nothing more',
      async (_label, change) => {
        const merchant = await gate.merchant();
        const slow = new OrderImportReleaseTickService(
          gate.repositories.releases,
          gate.repositories.integrations,
          gate.services.readiness,
          gate.repositories.events,
          gate.services.dispatcher,
          gate.scheduler as never,
          releaseGateConfig({ BULK_IMPORT_RELEASE_PER_MINUTE: '2' }),
        );
        const { session } = await uploadAndMap(
          merchant,
          [
            HEADER,
            ...[1, 2, 3].map(
              (n) => `PA-${n},Customer ${n},0101230003${n},300,COD`,
            ),
          ].join('\r\n'),
        );
        await session.commit();
        await session.start();
        await slow.tick(merchant.orgId);
        await gate.drain();
        await gate.db
          .update(integrations)
          .set(change as never)
          .where(eq(integrations.id, merchant.integrationId));
        await slow.tick(merchant.orgId);
        await gate.drain();

        expect(await batchState(session.batchId)).toMatchObject({
          status: 'paused',
          paused_reason: 'IMPORT_SETUP_INCOMPLETE',
        });
        const events = await gate.db
          .select()
          .from(webhookEvents)
          .where(eq(webhookEvents.holdGroupId, session.batchId));
        expect(
          events.filter((event) => event.holdState === 'released'),
        ).toHaveLength(1);
      },
    );

    it('a store timezone change during release: the next tick judges quiet hours in the new zone', async () => {
      const merchant = await gate.merchant({
        settings: {
          quietHoursEnabled: true,
          quietHoursStart: '22:00',
          quietHoursEnd: '08:00',
          timezone: 'UTC',
        },
      });
      const { session } = await uploadAndMap(
        merchant,
        [
          HEADER,
          ...[1, 2, 3].map(
            (n) => `TZ-${n},Customer ${n},0101230004${n},300,COD`,
          ),
        ].join('\r\n'),
      );
      await session.commit();
      await session.start();
      // 12:00 UTC: daytime in UTC, 02:00 the next day on Kiritimati (UTC+14).
      const noonUtc = new Date('2026-09-21T12:00:00Z');
      await expect(
        gate.services.ticks.tick(merchant.orgId, noonUtc),
      ).resolves.toMatchObject({ kind: 'released' });
      await gate.drain();

      const second = await uploadAndMap(
        merchant,
        [HEADER, 'TZ-9,Customer 9,01012300049,300,COD'].join('\r\n'),
      );
      await second.session.commit();
      await second.session.start();
      await gate.db
        .update(integrations)
        .set({ timezone: 'Pacific/Kiritimati' })
        .where(eq(integrations.id, merchant.integrationId));
      await expect(
        gate.services.ticks.tick(merchant.orgId, noonUtc),
      ).resolves.toMatchObject({ kind: 'quiet_hours' });
    });

    it('manual orders are never queued behind an import: one sends at once while a batch is still releasing', async () => {
      const merchant = await gate.merchant();
      const { session } = await uploadAndMap(
        merchant,
        [
          HEADER,
          ...Array.from(
            { length: 30 },
            (_, n) =>
              `MQ-${n},Customer ${n},010123${String(10_000 + n)},300,COD`,
          ),
        ].join('\r\n'),
      );
      await session.commit();
      await session.start();
      await gate.services.ticks.tick(merchant.orgId);
      await gate.drain();
      expect((await batchState(session.batchId)).status).toBe('releasing');

      const sendsBefore = gate.sends.length;
      const body = plainToInstance(CreateManualOrderDto, {
        customerPhone: '+201012399999',
        customerName: 'Walk In',
        orderNumber: 'WALK-1',
        totalPrice: '100.00',
        currency: 'EGP',
        paymentMethod: 'cash_on_delivery',
      });
      await validateOrReject(body);
      await gate.services.orders.createManualOrder(
        merchant.user,
        `gap-walk-in-${randomUUID()}`,
        body,
      );
      await gate.drain();
      // No tick ran: the manual order went out on its own dispatch.
      expect(
        gate.sends.slice(sendsBefore).map((send) => send.orderNumber),
      ).toEqual(['WALK-1']);
    });

    it('the feature flag turned off mid-release: the releasing batch still finishes at its pace', async () => {
      const merchant = await gate.merchant();
      const { session } = await uploadAndMap(
        merchant,
        [
          HEADER,
          ...[1, 2].map((n) => `FO-${n},Customer ${n},0101230005${n},300,COD`),
        ].join('\r\n'),
      );
      await session.commit();
      await session.start();
      const flagOff = new OrderImportReleaseTickService(
        gate.repositories.releases,
        gate.repositories.integrations,
        gate.services.readiness,
        gate.repositories.events,
        gate.services.dispatcher,
        gate.scheduler as never,
        releaseGateConfig({ STANDALONE_BULK_IMPORT_ENABLED: 'false' }),
      );
      expect(await session.releaseAll(5, flagOff)).toBe('completed');
    });

    it('a paused Meta template: an imported order fails exactly like a manual one, and neither is billed', async () => {
      const manual = await gate.merchant();
      const importer = await gate.merchant();
      gate.provider.rejecting = true;
      try {
        const body = plainToInstance(CreateManualOrderDto, {
          customerPhone: '+201012300061',
          customerName: 'Paused Template',
          orderNumber: 'PT-1',
          totalPrice: '200.00',
          currency: 'EGP',
          paymentMethod: 'cash_on_delivery',
        });
        await validateOrReject(body);
        const created = await gate.services.orders.createManualOrder(
          manual.user,
          `gap-paused-${randomUUID()}`,
          body,
        );
        await gate.drain();

        const { session } = await uploadAndMap(
          importer,
          [HEADER, 'PT-1,Paused Template,+201012300061,200,COD'].join('\r\n'),
        );
        await session.commit();
        await session.start();
        await session.releaseAll();
        const [importedOrderId] = [...(await session.importedRows()).values()];

        const outcome = async (orgId: string, orderId: string) => {
          const verification = await verificationOf(orderId);
          const [balance] = [await gate.repositories.credits.getSummary(orgId)];
          return {
            status: verification.status,
            reason: (verification.metadata as { reason?: string } | null)
              ?.reason,
            available: balance?.availableCredits,
            held: balance?.heldCredits,
          };
        };
        const manualOutcome = await outcome(manual.orgId, created.orderId);
        expect(await outcome(importer.orgId, importedOrderId)).toEqual(
          manualOutcome,
        );
        expect(manualOutcome).toMatchObject({
          status: 'failed',
          available: 100,
          held: 0,
        });
      } finally {
        gate.provider.rejecting = false;
      }
    });

    it('a merchant removes the member who started a batch: the batch carries on and keeps the actor id', async () => {
      const merchant = await gate.merchant();
      await gate.db.insert(memberships).values({
        orgId: merchant.orgId,
        userId: merchant.user.userId,
        role: 'admin',
      });
      const { session } = await uploadAndMap(
        merchant,
        [
          HEADER,
          ...[1, 2].map((n) => `RM-${n},Customer ${n},0101230007${n},300,COD`),
        ].join('\r\n'),
      );
      await session.commit();
      await session.start();
      await gate.db
        .delete(memberships)
        .where(eq(memberships.userId, merchant.user.userId));

      expect(await session.releaseAll()).toBe('completed');
      expect((await batchState(session.batchId)).attested_by).toBe(
        merchant.user.userId,
      );
    });
  });
});
