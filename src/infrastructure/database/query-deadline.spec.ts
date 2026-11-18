import { DatabaseTimeoutError } from '../../shared/errors/database-timeout.error';
import { boundPostgresClient } from './query-deadline';

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
  unsafe: jest.Mock<FakeQuery, [string?]>;
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
    expect(onTimeout).toHaveBeenCalledWith('query', 1_000);
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
    expect(onTimeout).toHaveBeenCalledWith('transaction', 5_000);
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
});
