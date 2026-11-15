import { performance } from 'node:perf_hooks';
import {
  currentRequestContext,
  recordQueryOn,
  recordTransaction,
} from '../../shared/request-context/request-context';

type Thenable = {
  then: (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
};

/**
 * Times a postgres.js `Query` for the active request. The query is a lazy
 * promise that starts executing when `then` is first called, and Drizzle
 * chains `.values()` on it before awaiting, so the instance itself is
 * returned with its `then` replaced rather than wrapped in a new promise.
 * The request context is captured when the statement is issued, so the time
 * lands on that request even when the promise settles elsewhere: the driver
 * sends queued statements from socket callbacks that carry no request store.
 */
function measure<T extends Thenable>(query: T, statement: string): T {
  const context = currentRequestContext();
  if (!context) return query;
  const startedAt = performance.now();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    recordQueryOn(context, statement, performance.now() - startedAt);
  };
  const originalThen = query.then;
  query.then = function instrumentedThen(onFulfilled, onRejected) {
    return originalThen.call(
      this,
      (value: unknown) => {
        settle();
        return onFulfilled ? onFulfilled(value) : value;
      },
      (reason: unknown) => {
        settle();
        if (onRejected) return onRejected(reason);
        throw reason;
      },
    ) as Promise<unknown>;
  };
  return query;
}

type ClientLike = {
  unsafe: (...args: unknown[]) => Thenable;
  begin: (...args: unknown[]) => unknown;
  savepoint: (...args: unknown[]) => unknown;
};

/**
 * Wraps Drizzle's statement, transaction and nested savepoint entry points,
 * so each application statement and transaction
 * is counted on the request that awaits it. Everything else is forwarded to
 * the driver untouched; outside a request context the wrapper is inert.
 */
export function instrumentPostgresClient<T extends object>(client: T): T {
  const target = client as unknown as ClientLike;
  return new Proxy(client, {
    get(_target, property) {
      if (property === 'unsafe') {
        return (...args: unknown[]) =>
          measure(
            target.unsafe(...args),
            typeof args[0] === 'string' ? args[0] : '',
          );
      }
      if (property === 'begin' || property === 'savepoint') {
        return (...args: unknown[]) => {
          const execute = (...values: unknown[]): unknown =>
            Reflect.apply(target[property], target, values);
          if (!currentRequestContext()) return execute(...args);
          if (property === 'begin') recordTransaction();
          const callback = args[args.length - 1];
          if (typeof callback !== 'function') return execute(...args);
          return execute(...args.slice(0, -1), (tx: object) =>
            (callback as (tx: object) => unknown)(instrumentPostgresClient(tx)),
          );
        };
      }
      return Reflect.get(client, property, client) as unknown;
    },
  });
}
