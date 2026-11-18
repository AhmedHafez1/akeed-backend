import {
  DatabaseTimeoutError,
  type DatabaseTimeoutScope,
} from '../../shared/errors/database-timeout.error';

type Thenable = {
  then: (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
  cancel?: () => unknown;
};

type ClientLike = {
  unsafe: (...args: unknown[]) => Thenable;
  begin: (...args: unknown[]) => Promise<unknown>;
  savepoint: (...args: unknown[]) => Promise<unknown>;
};

export interface QueryDeadlines {
  queryTimeoutMs: number;
  transactionTimeoutMs: number;
  onTimeout?: (scope: DatabaseTimeoutScope, timeoutMs: number) => void;
}

function startTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fn, ms);
  // A pending deadline must never keep a stopping process alive.
  timer.unref?.();
  return timer;
}

/**
 * Bounds one postgres.js `Query`. The query is a lazy promise that starts on
 * its first `then`, and Drizzle chains `.values()` on the instance before
 * awaiting it, so `then` is replaced on the instance rather than wrapped. The
 * clock starts with execution, so time spent queued for a pool connection
 * counts. On expiry the caller is rejected at once and the driver is asked to
 * cancel: a queued statement is dropped, a sent one gets a CancelRequest,
 * which a wedged pooler may never act on.
 */
function bindDeadline<T extends Thenable>(
  query: T,
  deadlines: QueryDeadlines,
): T {
  const originalThen = query.then;
  let bounded: Promise<unknown> | undefined;
  query.then = function boundedThen(onFulfilled, onRejected) {
    bounded ??= new Promise<unknown>((resolve, reject) => {
      const timer = startTimer(() => {
        reject(new DatabaseTimeoutError('query', deadlines.queryTimeoutMs));
        deadlines.onTimeout?.('query', deadlines.queryTimeoutMs);
        try {
          void Promise.resolve(query.cancel?.()).catch(() => undefined);
        } catch {
          // Cancelling is best effort; the caller already has its answer.
        }
      }, deadlines.queryTimeoutMs);
      originalThen.call(
        query,
        (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        (reason: unknown) => {
          clearTimeout(timer);
          // The driver's own error passes through unchanged.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(reason);
        },
      );
    });
    return bounded.then(onFulfilled, onRejected);
  };
  return query;
}

/**
 * A transaction holds one connection from BEGIN to COMMIT, and the driver
 * issues those itself, outside the statement bound. When the deadline passes
 * the caller is rejected while the transaction may still finish, which is the
 * same unknown outcome a dropped connection gives.
 */
function withTransactionDeadline(
  run: Promise<unknown>,
  deadlines: QueryDeadlines,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = startTimer(() => {
      reject(
        new DatabaseTimeoutError('transaction', deadlines.transactionTimeoutMs),
      );
      deadlines.onTimeout?.('transaction', deadlines.transactionTimeoutMs);
    }, deadlines.transactionTimeoutMs);
  });
  return Promise.race([run, expired]).finally(() => clearTimeout(timer));
}

/**
 * Wraps the driver entry points Drizzle uses (`unsafe` for every statement,
 * `begin` for transactions and `savepoint` for nested ones) so each
 * statement and each transaction has a deadline, inside transactions too.
 * Everything else is forwarded to the driver untouched.
 */
export function boundPostgresClient<T extends object>(
  client: T,
  deadlines: QueryDeadlines,
): T {
  const target = client as unknown as ClientLike;
  return new Proxy(client, {
    get(_target, property) {
      if (property === 'unsafe') {
        return (...args: unknown[]) =>
          bindDeadline(target.unsafe(...args), deadlines);
      }
      if (property === 'begin' || property === 'savepoint') {
        return (...args: unknown[]) => {
          const callback = args[args.length - 1];
          const boundArgs =
            typeof callback === 'function'
              ? [
                  ...args.slice(0, -1),
                  (tx: object) =>
                    (callback as (tx: object) => unknown)(
                      boundPostgresClient(tx, deadlines),
                    ),
                ]
              : args;
          const run: Promise<unknown> = Reflect.apply(
            target[property],
            target,
            boundArgs,
          );
          // A savepoint already runs inside a bounded transaction.
          return property === 'begin'
            ? withTransactionDeadline(run, deadlines)
            : run;
        };
      }
      return Reflect.get(client, property, client) as unknown;
    },
  });
}
