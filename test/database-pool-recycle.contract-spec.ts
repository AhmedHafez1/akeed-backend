import { Logger, type FactoryProvider } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import net from 'node:net';
import type postgres from 'postgres';
import {
  DATABASE_RESILIENCE_CONFIG,
  DATABASE_RESILIENCE_DEFAULTS,
  type DatabaseResilienceConfig,
} from '../src/shared/config/database-resilience.config';
import {
  databasePoolProvider,
  drizzleProvider,
  type DrizzleDB,
} from '../src/infrastructure/database/database.provider';
import type { DatabasePoolControl } from '../src/infrastructure/database/database-pool-control';
import { DatabasePoolWatchdog } from '../src/infrastructure/database/database-pool-watchdog';

const databaseUrl = process.env.E01_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

type Pair = { client: net.Socket; upstream: net.Socket; frozen: boolean };

/**
 * Forwards TCP to Postgres and can stop forwarding on every connection open
 * so far while still accepting new ones: what a pooler that stops answering
 * on open connections looks like to the driver.
 */
class FreezableProxy {
  private readonly pairs = new Set<Pair>();
  private server: net.Server | undefined;
  opened = 0;

  async start(target: URL): Promise<number> {
    const server = net.createServer((client) => {
      this.opened += 1;
      const upstream = net.connect(Number(target.port), target.hostname);
      const pair: Pair = { client, upstream, frozen: false };
      this.pairs.add(pair);
      client.on('data', (chunk) => {
        if (!pair.frozen) upstream.write(chunk);
      });
      upstream.on('data', (chunk) => {
        if (!pair.frozen) client.write(chunk);
      });
      const close = () => {
        this.pairs.delete(pair);
        client.destroy();
        upstream.destroy();
      };
      client.on('close', close);
      upstream.on('close', close);
      client.on('error', () => undefined);
      upstream.on('error', () => undefined);
    });
    this.server = server;
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    return (server.address() as net.AddressInfo).port;
  }

  freezeAll(): number {
    for (const pair of this.pairs) pair.frozen = true;
    return this.pairs.size;
  }

  async close(): Promise<void> {
    for (const pair of this.pairs) {
      pair.client.destroy();
      pair.upstream.destroy();
    }
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

function configService(
  url: string,
  resilience: DatabaseResilienceConfig,
): ConfigService {
  const values: Record<string, unknown> = {
    DATABASE_URL: url,
    DATABASE_POOL_MAX: '3',
    DATABASE_IDLE_TIMEOUT_SECONDS: '300',
    [DATABASE_RESILIENCE_CONFIG]: resilience,
  };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService;
}

function build(url: string, overrides: Partial<DatabaseResilienceConfig>) {
  const resilience: DatabaseResilienceConfig = {
    ...DATABASE_RESILIENCE_DEFAULTS,
    queryTimeoutMs: 1_500,
    transactionTimeoutMs: 4_000,
    pingTimeoutMs: 500,
    watchdogEnabled: true,
    watchdogIntervalMs: 300,
    watchdogFailures: 2,
    recycleEnabled: true,
    recycleDeadlines: 3,
    recycleWindowMs: 60_000,
    recycleCooldownMs: 60_000,
    ...overrides,
  };
  const config = configService(url, resilience);
  const control = (
    databasePoolProvider as FactoryProvider<DatabasePoolControl<postgres.Sql>>
  ).useFactory(config) as DatabasePoolControl<postgres.Sql>;
  const db = (drizzleProvider as FactoryProvider<DrizzleDB>).useFactory(
    config,
    control,
  ) as DrizzleDB;
  return { control, db, config };
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function selectOne(db: DrizzleDB): Promise<number> {
  const rows = await db.execute<{ value: number }>(sql`select 1 as value`);
  return Number(rows[0]?.value);
}

/** A read the deadline wrapper never retries: CTEs may modify data. */
async function selectOneOnce(db: DrizzleDB): Promise<number> {
  const rows = await db.execute<{ value: number }>(
    sql`with one as (select 1 as value) select value from one`,
  );
  return Number(rows[0]?.value);
}

describeWithDatabase('database pool replacement (disposable Postgres)', () => {
  let proxy: FreezableProxy;
  let proxyUrl: string;
  const controls: DatabasePoolControl[] = [];

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'fatal').mockImplementation(() => undefined);
  });

  beforeEach(async () => {
    proxy = new FreezableProxy();
    const target = new URL(databaseUrl!);
    const port = await proxy.start(target);
    const viaProxy = new URL(databaseUrl!);
    viaProxy.host = `127.0.0.1:${port}`;
    proxyUrl = viaProxy.toString();
  });

  afterEach(async () => {
    await Promise.all(controls.splice(0).map((each) => each.endAll(1)));
    await proxy.close();
  });

  afterAll(() => jest.restoreAllMocks());

  it('lets a running transaction commit on the replaced pool while new statements use fresh connections', async () => {
    const { control, db } = build(proxyUrl, {});
    controls.push(control);
    await db.execute(
      sql`create table if not exists pool_recycle_probe (id int primary key)`,
    );
    await db.execute(sql`truncate pool_recycle_probe`);
    const openedBefore = proxy.opened;

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const transaction = db.transaction(async (tx) => {
      await tx.execute(sql`insert into pool_recycle_probe values (1)`);
      await held;
      await tx.execute(sql`insert into pool_recycle_probe values (2)`);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(control.recycle('wedged')).toBe(true);
    expect(control.generation).toBe(2);
    await expect(selectOne(db)).resolves.toBe(1);
    expect(proxy.opened).toBeGreaterThan(openedBefore);

    release();
    await expect(transaction).resolves.toBeUndefined();
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from pool_recycle_probe`,
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('replaces a partly stuck pool after a burst of missed deadlines, without exiting', async () => {
    const { control, db } = build(proxyUrl, {});
    controls.push(control);
    // Open every pooled connection, then freeze them all.
    await Promise.all(
      [1, 2, 3].map(() => db.execute(sql`select pg_sleep(0.05)`)),
    );
    expect(proxy.freezeAll()).toBeGreaterThanOrEqual(3);

    const stuck = await Promise.allSettled(
      [1, 2, 3].map(() => selectOneOnce(db)),
    );
    expect(stuck.every((result) => result.status === 'rejected')).toBe(true);
    // Drizzle wraps the driver error; the deadline is its cause.
    expect(
      stuck.map((result) => {
        if (result.status !== 'rejected') return 'fulfilled';
        const reason = result.reason as {
          code?: string;
          cause?: { code?: string };
        };
        return reason.cause?.code ?? reason.code;
      }),
    ).toEqual(['DATABASE_TIMEOUT', 'DATABASE_TIMEOUT', 'DATABASE_TIMEOUT']);

    await waitFor(() => control.generation === 2, 5_000);
    await expect(selectOne(db)).resolves.toBe(1);
  });

  it('answers a read that hits a stuck connection by retrying it on the replacement pool', async () => {
    const { control, db } = build(proxyUrl, { recycleDeadlines: 1 });
    controls.push(control);
    await Promise.all(
      [1, 2, 3].map(() => db.execute(sql`select pg_sleep(0.05)`)),
    );
    expect(proxy.freezeAll()).toBeGreaterThanOrEqual(3);
    const startedAt = Date.now();

    await expect(selectOne(db)).resolves.toBe(1);

    expect(control.generation).toBe(2);
    // One missed deadline, then the retry on a fresh connection.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('ends the process when the replacement pool is stuck again within the cooldown', async () => {
    const { control, db, config } = build(proxyUrl, {});
    controls.push(control);
    const watchdog = new DatabasePoolWatchdog(db, config, control);
    const exitProcess = jest.fn();
    watchdog.exitProcess = exitProcess;

    await Promise.all(
      [1, 2, 3].map(() => db.execute(sql`select pg_sleep(0.05)`)),
    );
    proxy.freezeAll();
    watchdog.onApplicationBootstrap();
    // Occupy every connection so the watchdog's ping cannot get one.
    const occupied = [1, 2, 3].map(() => selectOne(db).catch(() => undefined));

    await waitFor(() => control.generation === 2, 10_000);
    expect(exitProcess).not.toHaveBeenCalled();
    await expect(selectOne(db)).resolves.toBe(1);

    await Promise.all(
      [1, 2, 3].map(() => db.execute(sql`select pg_sleep(0.05)`)),
    );
    proxy.freezeAll();
    const occupiedAgain = [1, 2, 3].map(() =>
      selectOne(db).catch(() => undefined),
    );

    await waitFor(() => exitProcess.mock.calls.length > 0, 10_000);
    expect(control.generation).toBe(2);
    watchdog.onModuleDestroy();
    await Promise.all([...occupied, ...occupiedAgain]);
  });
});
