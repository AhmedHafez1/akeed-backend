import { DatabaseTimeoutError } from '../../shared/errors/database-timeout.error';
import type { DatabaseTimeoutScope } from '../../shared/errors/database-timeout.error';
import {
  boundPostgresClient,
  isRetryableRead,
  type DeadlineDetails,
} from './query-deadline';

const timeoutSpy = () =>
  jest.fn<void, [DatabaseTimeoutScope, number, DeadlineDetails]>();

type Settle = {
  resolve: (value: unknown) => void;
  reject: (e: unknown) => void;
};

function fakeQuery() {
  const settle = {} as Settle;
  const promise = new Promise<unknown>((resolve, reject) => {
    settle.resolve = resolve;
    settle.reject = reject;
  });
  const then = jest.fn(
    (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => promise.then(onFulfilled, onRejected),
  );
  const query = { then, cancel: jest.fn(() => Promise.resolve()) };
  return { query, settle, then };
}

type FakeQuery = ReturnType<typeof fakeQuery>['query'];

interface FakeClient {
  unsafe: jest.Mock<FakeQuery, [string?, unknown[]?]>;
  begin: jest.Mock<Promise<unknown>, [(tx: FakeClient) => Promise<unknown>]>;
  savepoint: jest.Mock<
    Promise<unknown>,
    [(tx: FakeClient) => Promise<unknown>]
  >;
  options: { host: string[] };
}

function fakeClient(queries: ReturnType<typeof fakeQuery>[]): FakeClient {
  const client: FakeClient = {
    unsafe: jest.fn(() => queries.shift()!.query),
    begin: jest.fn((callback: (tx: FakeClient) => Promise<unknown>) =>
      callback(client),
    ),
    savepoint: jest.fn((callback: (tx: FakeClient) => Promise<unknown>) =>
      callback(client),
    ),
    options: { host: ['db'] },
  };
  return client;
}

// The driver starts a statement on its first then, which Promise.resolve
// calls on a later microtask.
async function started(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

const deadlines = { queryTimeoutMs: 1_000, transactionTimeoutMs: 5_000 };

describe('boundPostgresClient', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('passes results through when the statement answers in time', async () => {
    const first = fakeQuery();
    const client = boundPostgresClient(fakeClient([first]), deadlines);

    const result = client.unsafe('select 1');
    const awaited = Promise.resolve(result);
    first.settle.resolve([{ one: 1 }]);

    await expect(awaited).resolves.toEqual([{ one: 1 }]);
    jest.advanceTimersByTime(5_000);
    expect(first.query.cancel).not.toHaveBeenCalled();
  });

  it('keeps the query instance so Drizzle can chain on it', () => {
    const first = fakeQuery();
    const client = boundPostgresClient(fakeClient([first]), deadlines);

    expect(client.unsafe('select 1')).toBe(first.query);
  });

  it('rejects at the deadline, cancels the statement and reports it', async () => {
    const first = fakeQuery();
    const onTimeout = jest.fn();
    const client = boundPostgresClient(fakeClient([first]), {
      ...deadlines,
      onTimeout,
    });

    const awaited = Promise.resolve(client.unsafe('select 1'));
    const assertion = expect(awaited).rejects.toEqual(
      new DatabaseTimeoutError('query', 1_000),
    );
    await started();
    jest.advanceTimersByTime(1_000);

    await assertion;
    expect(first.query.cancel).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(
      'query',
      1_000,
      expect.objectContaining({ retry: false }),
    );
    // A late answer from the driver changes nothing.
    first.settle.reject(new Error('canceling statement due to user request'));
    await Promise.resolve();
  });

  it('runs the statement once however many times it is awaited', async () => {
    const first = fakeQuery();
    const client = boundPostgresClient(fakeClient([first]), deadlines);
    const query = client.unsafe('select 1');

    const a = Promise.resolve(query);
    const b = Promise.resolve(query);
    first.settle.resolve('rows');

    await expect(Promise.all([a, b])).resolves.toEqual(['rows', 'rows']);
    expect(first.then).toHaveBeenCalledTimes(1);
  });

  it('passes driver errors through unchanged', async () => {
    const first = fakeQuery();
    const client = boundPostgresClient(fakeClient([first]), deadlines);
    const failure = Object.assign(new Error('duplicate key'), {
      code: '23505',
    });

    const awaited = Promise.resolve(client.unsafe('insert'));
    first.settle.reject(failure);

    await expect(awaited).rejects.toBe(failure);
  });

  it('bounds statements inside transactions and savepoints', async () => {
    const inner = fakeQuery();
    const raw = fakeClient([inner]);
    const client = boundPostgresClient(raw, deadlines);

    const transaction = client.begin((tx: typeof raw) =>
      tx.savepoint((nested: typeof raw) =>
        Promise.resolve(nested.unsafe('update')),
      ),
    );
    const assertion = expect(transaction).rejects.toEqual(
      new DatabaseTimeoutError('query', 1_000),
    );
    await started();
    jest.advanceTimersByTime(1_000);

    await assertion;
    expect(inner.query.cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a transaction that outlives its deadline', async () => {
    const onTimeout = jest.fn();
    const raw = fakeClient([]);
    raw.begin.mockImplementation(() => new Promise(() => undefined));
    const client = boundPostgresClient(raw, { ...deadlines, onTimeout });

    const transaction = client.begin(() => Promise.resolve());
    const assertion = expect(transaction).rejects.toEqual(
      new DatabaseTimeoutError('transaction', 5_000),
    );
    jest.advanceTimersByTime(5_000);

    await assertion;
    expect(onTimeout).toHaveBeenCalledWith(
      'transaction',
      5_000,
      expect.objectContaining({
        retry: false,
        caller: expect.stringMatching(/query-deadline\.spec/) as unknown,
      }),
    );
  });

  it('returns a transaction result that arrives in time', async () => {
    const client = boundPostgresClient(fakeClient([]), deadlines);

    await expect(
      client.begin(() => Promise.resolve('committed')),
    ).resolves.toBe('committed');
  });

  it('forwards everything else to the driver', () => {
    const raw = fakeClient([]);
    const client = boundPostgresClient(raw, deadlines);

    expect(client.options).toBe(raw.options);
  });

  it('names the application caller of a missed statement', async () => {
    const first = fakeQuery();
    const onTimeout = timeoutSpy();
    const client = boundPostgresClient(fakeClient([first]), {
      ...deadlines,
      onTimeout,
    });

    const awaited = Promise.resolve(client.unsafe('update'));
    const assertion =
      expect(awaited).rejects.toBeInstanceOf(DatabaseTimeoutError);
    await started();
    jest.advanceTimersByTime(1_000);

    await assertion;
    const details = onTimeout.mock.calls[0][2];
    expect(details.retry).toBe(false);
    expect(details.caller).toMatch(/query-deadline\.spec/);
  });

  describe('retrying reads', () => {
    const retrying = { ...deadlines, retryReads: true };

    it('runs a missed read once more after the deadline decision settles', async () => {
      const first = fakeQuery();
      const second = fakeQuery();
      const raw = fakeClient([first, second]);
      let decide: () => void = () => undefined;
      const onTimeout = jest.fn(
        () => new Promise<void>((resolve) => (decide = resolve)),
      );
      const client = boundPostgresClient(raw, { ...retrying, onTimeout });

      const query = client.unsafe('select * from orders where id = $1', [7]);
      (query as { isRaw?: unknown }).isRaw = 'values';
      const awaited = Promise.resolve(query);
      await started();
      jest.advanceTimersByTime(1_000);

      expect(first.query.cancel).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith(
        'query',
        1_000,
        expect.objectContaining({ retry: true }),
      );
      // The cancelled statement's error does not reach the caller.
      first.settle.reject(new Error('canceling statement'));
      await started();
      expect(raw.unsafe).toHaveBeenCalledTimes(1);

      decide();
      await started();
      expect(raw.unsafe).toHaveBeenCalledTimes(2);
      expect(raw.unsafe).toHaveBeenLastCalledWith(
        'select * from orders where id = $1',
        [7],
      );
      expect((second.query as { isRaw?: unknown }).isRaw).toBe('values');
      second.settle.resolve([[1]]);

      await expect(awaited).resolves.toEqual([[1]]);
    });

    it('rejects when the retried read misses its deadline too, without a third run', async () => {
      const first = fakeQuery();
      const second = fakeQuery();
      const raw = fakeClient([first, second]);
      const onTimeout = timeoutSpy();
      const client = boundPostgresClient(raw, { ...retrying, onTimeout });

      const awaited = Promise.resolve(client.unsafe('select 1'));
      const assertion = expect(awaited).rejects.toEqual(
        new DatabaseTimeoutError('query', 1_000),
      );
      await started();
      jest.advanceTimersByTime(1_000);
      await started();
      jest.advanceTimersByTime(1_000);

      await assertion;
      expect(raw.unsafe).toHaveBeenCalledTimes(2);
      expect(onTimeout.mock.calls.map((call) => call[2].retry)).toEqual([
        true,
        false,
      ]);
    });

    it('accepts a late answer from the first run while retrying', async () => {
      const first = fakeQuery();
      const second = fakeQuery();
      const client = boundPostgresClient(fakeClient([first, second]), {
        ...retrying,
        onTimeout: () => new Promise(() => undefined),
      });

      const awaited = Promise.resolve(client.unsafe('select 1'));
      await started();
      jest.advanceTimersByTime(1_000);
      first.settle.resolve('late rows');

      await expect(awaited).resolves.toBe('late rows');
    });

    it.each([
      'insert into orders values (1)',
      'with moved as (delete from x returning *) select * from moved',
      'select * from orders for update',
      'select * from orders for no key update skip locked',
      'select pg_advisory_lock(1)',
      "select nextval('orders_seq')",
    ])('never retries %s', async (statement) => {
      const first = fakeQuery();
      const raw = fakeClient([first]);
      const client = boundPostgresClient(raw, retrying);

      const awaited = Promise.resolve(client.unsafe(statement));
      const assertion = expect(awaited).rejects.toEqual(
        new DatabaseTimeoutError('query', 1_000),
      );
      await started();
      jest.advanceTimersByTime(1_000);

      await assertion;
      expect(raw.unsafe).toHaveBeenCalledTimes(1);
    });

    it('never retries a read inside a transaction', async () => {
      const inner = fakeQuery();
      const raw = fakeClient([inner]);
      const client = boundPostgresClient(raw, retrying);

      const transaction = client.begin((tx: typeof raw) =>
        Promise.resolve(tx.unsafe('select 1')),
      );
      const assertion = expect(transaction).rejects.toEqual(
        new DatabaseTimeoutError('query', 1_000),
      );
      await started();
      jest.advanceTimersByTime(1_000);

      await assertion;
      expect(raw.unsafe).toHaveBeenCalledTimes(1);
    });
  });
});

describe('isRetryableRead', () => {
  it('accepts plain selects only', () => {
    expect(isRetryableRead('  SELECT id FROM orders')).toBe(true);
    expect(isRetryableRead('select "for" from t')).toBe(true);
    expect(isRetryableRead('update orders set x = 1')).toBe(false);
    expect(isRetryableRead('select * from t for share')).toBe(false);
    expect(isRetryableRead('select pg_try_advisory_lock(1)')).toBe(false);
  });
});
