import type { Job } from 'bullmq';
import { cpus, platform, release, totalmem } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ImportManifest } from '../scripts/order-import-fixtures/build-fixtures';
import { IMPORT_FIELDS } from '../src/modules/order-imports/mapping/alias-dictionary';
import { releaseBudgetPerTick } from '../src/modules/order-imports/release/release-policy';
import { readBulkImportConfig } from '../src/shared/config/bulk-import.config';
import { releaseGateHarness } from './contracts/release-gate-harness';

/*
 * US-04.6-10 AC6, measured locally on disposable PostgreSQL through the same
 * real services as the release-gate suite. These numbers are a local
 * baseline only: the targets are defined on staging, so every result is
 * reported as TARGET VALIDATION REQUIRED. Run with
 * `scripts/perf/order-import-gate-perf.ps1`.
 */

const FIXTURES = resolve(__dirname, 'fixtures/order-imports');
const FILE = '5000-rows.csv';
const RUNS = Number(process.env.PERF_RUNS ?? 20);
const COMMIT_RUNS = Number(process.env.PERF_COMMIT_RUNS ?? RUNS);
const TICKS = Number(process.env.PERF_TICKS ?? 20);
const OUT = process.env.PERF_OUT;

const gate = releaseGateHarness();
const manifest = JSON.parse(
  readFileSync(join(FIXTURES, `${FILE}.manifest.json`), 'utf8'),
) as ImportManifest;
const bytes = readFileSync(join(FIXTURES, FILE));

function mappingBody() {
  const mapping: Record<string, unknown> = Object.fromEntries(
    IMPORT_FIELDS.map((field) => [field, manifest.mapping?.[field] ?? null]),
  );
  mapping.customerName = manifest.mapping?.customerName ?? [];
  return {
    mapping,
    options: {
      country: manifest.country,
      defaultCurrency: manifest.defaultCurrency,
      dateFormat: 'auto',
      paymentValueMap: {},
    },
  } as never;
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index]);
}

function summary(samples: number[], targetMs: number | null) {
  return {
    runs: samples.length,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: Math.round(Math.max(...samples)),
    targetMs,
    verdict: 'TARGET VALIDATION REQUIRED',
  };
}

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await work();
  return [value, performance.now() - started];
}

type Merchant = Awaited<ReturnType<typeof gate.merchant>>;

/** A store configured as the manifest describes (COD assumed when blank). */
function storeMerchant(credits?: number) {
  return gate.merchant({
    credits,
    settings: {
      assumeCodWhenPaymentMissing: manifest.assumeCodWhenPaymentMissing,
    },
  });
}

/** Upload → parse, persist, auto-map → Save mapping (validates) → first page. */
async function uploadToPreview(merchant: Merchant) {
  return timed(async () => {
    const uploaded = await gate.services.uploads.upload(
      merchant.user,
      merchant.source,
      { buffer: bytes, size: bytes.length, originalname: FILE },
    );
    await gate.services.mapping.save(
      merchant.user,
      merchant.source,
      uploaded.batchId,
      mappingBody(),
    );
    await gate.services.detail.detail(merchant.user, uploaded.batchId);
    await gate.services.rows.list(merchant.user, uploaded.batchId, {
      outcome: 'ready',
      limit: 100,
    } as never);
    return uploaded.batchId;
  });
}

/** Commit request → the commit worker has turned every ready row into an order. */
async function commit(merchant: Merchant, batchId: string) {
  const [, ms] = await timed(async () => {
    await gate.services.commits.commit(
      merchant.user,
      merchant.source,
      batchId,
      `perf-commit-${batchId}`,
    );
    for (const job of gate.commitJobs.splice(0))
      await gate.services.commitProcessor.process({ data: job } as Job<{
        batchId: string;
        orgId: string;
      }>);
  });
  const [{ orders }] = await gate.client<{ orders: number }[]>`
    SELECT count(*)::int AS orders FROM order_import_rows
    WHERE batch_id = ${batchId} AND order_id IS NOT NULL`;
  return { ms, orders };
}

describe('US-04.6-10 AC6 local performance baseline (5000-rows.csv)', () => {
  const results: Record<string, unknown> = {};

  beforeAll(() => gate.setup());
  afterAll(async () => {
    const report = {
      measuredAt: new Date().toISOString(),
      fixture: FILE,
      hardware: {
        cpu: cpus()[0]?.model.trim(),
        logicalCores: cpus().length,
        memoryGiB: Math.round(totalmem() / 2 ** 30),
        os: `${platform()} ${release()}`,
        node: process.version,
        database: 'postgres:17-alpine in Docker Desktop (disposable)',
      },
      results,
    };
    console.log(JSON.stringify(report, null, 2));
    if (OUT) {
      mkdirSync(dirname(OUT), { recursive: true });
      // CRLF, like every file in the repository.
      writeFileSync(
        OUT,
        `${JSON.stringify(report, null, 2).replace(/\n/g, '\r\n')}\r\n`,
      );
    }
    await gate.teardown();
  });

  it('database round trip, 1000 runs (context for the numbers below)', async () => {
    // The commit writes each row in its own savepoint, so part of its time
    // is round trips; this machine's latency to the container is what
    // staging's must be compared against.
    const samples: number[] = [];
    for (let run = 0; run < 1000; run++) {
      const [, ms] = await timed(() => gate.client`SELECT 1`);
      samples.push(ms);
    }
    results.databaseRoundTrip = {
      runs: samples.length,
      p50Ms: Number(
        [...samples].sort((a, b) => a - b)[samples.length / 2].toFixed(2),
      ),
    };
  });

  it(`upload → preview, ${RUNS} runs (target < 10 s p95)`, async () => {
    const samples: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const merchant = await storeMerchant();
      const [, ms] = await uploadToPreview(merchant);
      samples.push(ms);
    }
    results.uploadToPreview = summary(samples, 10_000);
  });

  it(`commit of 5,000 rows, ${COMMIT_RUNS} runs (target < 60 s)`, async () => {
    const samples: number[] = [];
    for (let run = 0; run < COMMIT_RUNS; run++) {
      // A fresh organization each run, so L1 never collapses a rerun.
      const merchant = await storeMerchant();
      const [batchId] = await uploadToPreview(merchant);
      const { ms, orders } = await commit(merchant, batchId);
      expect(orders).toBe(5000);
      samples.push(ms);
    }
    results.commit5000 = summary(samples, 60_000);
  });

  it(`release lag from the planned tick, ${TICKS} ticks (target < 60 s)`, async () => {
    const merchant = await storeMerchant(6000);
    const [batchId] = await uploadToPreview(merchant);
    await commit(merchant, batchId);
    const quote = await gate.services.starts.quote(
      merchant.user,
      merchant.source,
      batchId,
    );
    await gate.services.starts.start(
      merchant.user,
      merchant.source,
      batchId,
      `perf-start-${batchId}`,
      { quoteToken: quote.quoteToken },
    );

    const budget = releaseBudgetPerTick(
      readBulkImportConfig(gate.config).releasePerMinute,
    );
    const tickSamples: number[] = [];
    const sendSamples: number[] = [];
    for (let tick = 0; tick < TICKS; tick++) {
      const sentBefore = gate.sends.length;
      // Lag: the tick fires on schedule; measured until its held events are
      // released and handed to the dispatcher.
      const [outcome, tickMs] = await timed(() =>
        gate.services.ticks.tick(merchant.orgId),
      );
      expect(outcome.kind).toBe('released');
      // Then until the existing pipeline has sent them (fake messaging port).
      const [, sendMs] = await timed(() => gate.drain());
      expect(gate.sends.length - sentBefore).toBe(budget);
      tickSamples.push(tickMs);
      sendSamples.push(tickMs + sendMs);
    }
    results.releaseLag = {
      eventsPerTick: budget,
      tickToReleased: summary(tickSamples, 60_000),
      tickToSent: summary(sendSamples, 60_000),
    };
  });

  it('exports (target < 5 s): N/A, errors.csv/results.csv deferred with US-04.6-08', () => {
    results.exports = { verdict: 'N/A (deferred)' };
  });
});
