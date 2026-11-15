import { instrumentPostgresClient } from './query-instrumentation';
import {
  createRequestContext,
  runRequestContext,
} from '../../shared/request-context/request-context';

/**
 * Mirrors postgres.js: a query is a lazy promise that starts executing when
 * `then` is first called, and `.values()` returns the same instance.
 */
class FakeQuery {
  started = 0;
  constructor(private readonly execute: () => Promise<unknown>) {}
  then(
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown> {
    this.started += 1;
    return this.execute().then(onFulfilled, onRejected);
  }
  values(): this {
    return this;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeClient(
  run: (statement: string) => Promise<unknown> = () => Promise.resolve([]),
) {
  const queries: FakeQuery[] = [];
  const unsafe = jest.fn((statement: string): FakeQuery => {
    const query = new FakeQuery(() => run(statement));
    queries.push(query);
    return query;
  });
  const begin = jest.fn(
    (callback: (tx: unknown) => unknown): Promise<unknown> =>
      Promise.resolve(callback(client)),
  );
  const end = jest.fn((): string => 'ended');
  const client = { options: { max: 10 }, unsafe, begin, savepoint: begin, end };
  return { client, queries };
}

describe('postgres client instrumentation', () => {
  it('keeps statements inside nested savepoints in the same request', async () => {
    const { client } = fakeClient();
    const db = instrumentPostgresClient(client);
    const context = createRequestContext();
    await runRequestContext(context, () =>
      db.begin(async (tx) => {
        await (tx as typeof db).savepoint((nested) =>
          (nested as typeof db).unsafe('select 1').values(),
        );
      }),
    );
    expect(context.db).toMatchObject({ count: 1, transactions: 1, writes: 1 });
  });
  it('counts and times each statement on the request that awaits it', async () => {
    const { client, queries } = fakeClient(() => delay(5).then(() => []));
    const db = instrumentPostgresClient(client);
    const context = createRequestContext();
    await runRequestContext(context, async () => {
      await db.unsafe('select 1').values();
      await db.unsafe('update integrations set store_name = $1');
    });
    expect(context.db.count).toBe(2);
    expect(context.db.writes).toBe(1);
    expect(context.db.totalMs).toBeGreaterThan(0);
    expect(context.db.maxMs).toBeLessThanOrEqual(context.db.totalMs);
    // Each query executed exactly once despite the replaced `then`.
    expect(queries.map((query) => query.started)).toEqual([1, 1]);
  });

  it('records a failed statement and rethrows its error', async () => {
    const { client } = fakeClient(() =>
      Promise.reject(new Error('synthetic failure')),
    );
    const db = instrumentPostgresClient(client);
    const context = createRequestContext();
    await expect(
      runRequestContext(context, () => db.unsafe('select 1')),
    ).rejects.toThrow('synthetic failure');
    expect(context.db.count).toBe(1);
  });

  it('settles once even when awaited twice', async () => {
    const { client } = fakeClient();
    const db = instrumentPostgresClient(client);
    const context = createRequestContext();
    await runRequestContext(context, async () => {
      const query = db.unsafe('select 1');
      await query;
      await query;
    });
    expect(context.db.count).toBe(1);
  });

  it('passes statements through untouched outside a request', async () => {
    const { client, queries } = fakeClient();
    const db = instrumentPostgresClient(client);
    const query = db.unsafe('select 1');
    expect(query).toBe(queries[0]);
    expect(Object.prototype.hasOwnProperty.call(query, 'then')).toBe(false);
    await expect(query).resolves.toEqual([]);
  });

  it('attributes concurrent requests to their own contexts', async () => {
    const { client } = fakeClient((statement) =>
      delay(statement.includes('slow') ? 20 : 1).then(() => []),
    );
    const db = instrumentPostgresClient(client);
    const slow = createRequestContext();
    const fast = createRequestContext();
    await Promise.all([
      runRequestContext(slow, () => db.unsafe('select slow')),
      runRequestContext(fast, async () => {
        await db.unsafe('select 1');
        await db.unsafe('select 2');
      }),
    ]);
    expect(slow.db.count).toBe(1);
    expect(fast.db.count).toBe(2);
    expect(slow.db.maxMs).toBeGreaterThan(fast.db.maxMs);
  });

  it('counts a transaction as a write and instruments its statements', async () => {
    const { client } = fakeClient();
    const db = instrumentPostgresClient(client);
    const context = createRequestContext();
    await runRequestContext(context, () =>
      db.begin((tx) => (tx as typeof db).unsafe('select 1')),
    );
    expect(context.db).toMatchObject({ count: 1, transactions: 1, writes: 1 });
    expect(client.begin).toHaveBeenCalledTimes(1);
  });

  it('leaves a transaction alone outside a request', async () => {
    const { client } = fakeClient();
    const db = instrumentPostgresClient(client);
    const callback = jest.fn(() => Promise.resolve('done'));
    await expect(db.begin(callback)).resolves.toBe('done');
    expect(callback).toHaveBeenCalledWith(client);
  });

  it('forwards other members to the driver untouched', () => {
    const { client } = fakeClient();
    const db = instrumentPostgresClient(client);
    expect(db.options).toEqual({ max: 10 });
    expect(db.end).toBe(client.end);
  });
});
