import { basename } from 'node:path';
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

export interface DeadlineDetails {
  /** The application function that issued the statement or transaction. */
  caller?: string;
  /** Whether the statement is run again once the returned promise settles. */
  retry: boolean;
}

export interface QueryDeadlines {
  queryTimeoutMs: number;
  transactionTimeoutMs: number;
  /**
   * Called at every missed deadline. A read that is retried waits for the
   * returned promise first, so the retry can run on a replacement pool.
   */
  onTimeout?: (
    scope: DatabaseTimeoutScope,
    timeoutMs: number,
    details: DeadlineDetails,
  ) => void | Promise<unknown>;
  /** Run a plain read again, once, when it misses its deadline. */
  retryReads?: boolean;
}

function startTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fn, ms);
  // A pending deadline must never keep a stopping process alive.
  timer.unref?.();
  return timer;
}

const LOCKING_READ = /\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i;
const SIDE_EFFECT_FUNCTION =
  /\b(pg_advisory\w*|pg_try_advisory\w*|nextval|setval)\s*\(/i;

/**
 * A statement that can run twice with the same effect as once: a plain
 * `select` that takes no row or advisory locks and moves no sequence. CTEs
 * are excluded because they may modify data.
 */
export function isRetryableRead(statement: string): boolean {
  return (
    /^select\b/i.test(statement.trimStart()) &&
    !LOCKING_READ.test(statement) &&
    !SIDE_EFFECT_FUNCTION.test(statement)
  );
}

const OWN_FILES = new Set([
  'query-deadline',
  'query-instrumentation',
  'swappable-client',
  'database.provider',
]);
const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?$/;

/**
 * Captures where a statement was issued. Only the frames are recorded here;
 * V8 formats the stack when it is read, which happens only at a deadline.
 */
function captureOrigin(): Error {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const origin = new Error();
  Error.stackTraceLimit = limit;
  return origin;
}

/** The first application frame of `origin`: a function name or file and line. */
export function callerOf(origin: Error): string | undefined {
  for (const line of (origin.stack ?? '').split('\n').slice(1)) {
    const frame = FRAME.exec(line);
    if (!frame) continue;
    const [, name, file, lineNumber] = frame;
    if (file.includes('node_modules') || file.startsWith('node:')) continue;
    const module = basename(file).replace(/\.(js|ts)$/, '');
    if (OWN_FILES.has(module)) continue;
    return name && !name.includes('<anonymous>') && !name.startsWith('Proxy.')
      ? name
      : `${module}:${lineNumber}`;
  }
  return undefined;
}

function cancelQuietly(query: Thenable): void {
  try {
    void Promise.resolve(query.cancel?.()).catch(() => undefined);
  } catch {
    // Cancelling is best effort; the caller already has its answer.
  }
}

/**
 * Bounds one postgres.js `Query`. The query is a lazy promise that starts on
 * its first `then`, and Drizzle chains `.values()` on the instance before
 * awaiting it, so `then` is replaced on the instance rather than wrapped. The
 * clock starts with execution, so time spent queued for a pool connection
 * counts. On expiry the driver is asked to cancel: a queued statement is
 * dropped, a sent one gets a CancelRequest, which a wedged pooler may never
 * act on.
 *
 * The connection that missed the deadline keeps its statement until the
 * socket closes, and the driver keeps handing it new statements whenever
 * every connection is busy. A read given `reissue` therefore runs once more,
 * after `onTimeout`'s promise settles (by then the pool may have been
 * replaced), with a deadline of its own; whichever answer arrives first wins.
 * Anything else is rejected at once.
 */
function bindDeadline<T extends Thenable>(
  query: T,
  deadlines: QueryDeadlines,
  origin: Error,
  reissue?: () => T,
): T {
  const originalThen = query.then;
  let bounded: Promise<unknown> | undefined;
  query.then = function boundedThen(onFulfilled, onRejected) {
    bounded ??= new Promise<unknown>((resolve, reject) => {
      let retrying = false;
      const timer = startTimer(() => {
        const details = { caller: callerOf(origin), retry: !!reissue };
        if (!reissue) {
          reject(new DatabaseTimeoutError('query', deadlines.queryTimeoutMs));
          void deadlines.onTimeout?.(
            'query',
            deadlines.queryTimeoutMs,
            details,
          );
          cancelQuietly(query);
          return;
        }
        retrying = true;
        const decided = deadlines.onTimeout?.(
          'query',
          deadlines.queryTimeoutMs,
          details,
        );
        cancelQuietly(query);
        Promise.resolve(decided)
          .catch(() => undefined)
          .then(() => reissue())
          .then(resolve, reject);
      }, deadlines.queryTimeoutMs);
      originalThen.call(
        query,
        (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        (reason: unknown) => {
          clearTimeout(timer);
          // Once retrying, the cancelled statement's error is expected.
          if (retrying) return;
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
 * same unknown outcome a dropped connection gives. Transactions are never
 * retried here.
 */
function withTransactionDeadline(
  run: Promise<unknown>,
  deadlines: QueryDeadlines,
  origin: Error,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = startTimer(() => {
      reject(
        new DatabaseTimeoutError('transaction', deadlines.transactionTimeoutMs),
      );
      void deadlines.onTimeout?.(
        'transaction',
        deadlines.transactionTimeoutMs,
        {
          caller: callerOf(origin),
          retry: false,
        },
      );
    }, deadlines.transactionTimeoutMs);
  });
  return Promise.race([run, expired]).finally(() => clearTimeout(timer));
}

/**
 * Wraps the driver entry points Drizzle uses (`unsafe` for every statement,
 * `begin` for transactions and `savepoint` for nested ones) so each
 * statement and each transaction has a deadline, inside transactions too.
 * Reads are retried only outside transactions. Everything else is forwarded
 * to the driver untouched.
 */
export function boundPostgresClient<T extends object>(
  client: T,
  deadlines: QueryDeadlines,
): T {
  const target = client as unknown as ClientLike;
  const bound = (args: unknown[], origin: Error, retry: boolean): Thenable => {
    const query = target.unsafe(...args);
    const statement = typeof args[0] === 'string' ? args[0] : '';
    const reissue =
      retry && isRetryableRead(statement)
        ? () => {
            const again = bound(args, origin, false);
            // Drizzle asks for array rows with `.values()` after the call.
            (again as { isRaw?: unknown }).isRaw = (
              query as { isRaw?: unknown }
            ).isRaw;
            return again;
          }
        : undefined;
    return bindDeadline(query, deadlines, origin, reissue);
  };
  return new Proxy(client, {
    get(_target, property) {
      if (property === 'unsafe') {
        return (...args: unknown[]) =>
          bound(args, captureOrigin(), deadlines.retryReads === true);
      }
      if (property === 'begin' || property === 'savepoint') {
        return (...args: unknown[]) => {
          const origin = captureOrigin();
          const inner = { ...deadlines, retryReads: false };
          const callback = args[args.length - 1];
          const boundArgs =
            typeof callback === 'function'
              ? [
                  ...args.slice(0, -1),
                  (tx: object) =>
                    (callback as (tx: object) => unknown)(
                      boundPostgresClient(tx, inner),
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
            ? withTransactionDeadline(run, deadlines, origin)
            : run;
        };
      }
      return Reflect.get(client, property, client) as unknown;
    },
  });
}
