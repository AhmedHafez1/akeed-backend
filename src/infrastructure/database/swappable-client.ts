type TypeHandlers = Record<string, unknown>;

type ClientShape = {
  options?: { parsers?: TypeHandlers; serializers?: TypeHandlers };
  end?: (options?: { timeout?: number }) => Promise<unknown>;
};

export type DrainOutcome = 'ended' | 'failed';

export interface SwappableClient<T extends object> {
  /** Stable handle that always reaches the current driver client. */
  readonly client: T;
  readonly generation: number;
  /**
   * Makes a new driver client current and ends the previous one. Statements
   * and transactions already running on the previous client keep it until
   * they settle or `drainTimeoutSeconds` passes; its sockets are then
   * destroyed, which rejects anything still waiting on them.
   */
  replace(drainTimeoutSeconds: number): {
    generation: number;
    drained: Promise<DrainOutcome>;
  };
  /** Ends the current client and every client still draining. */
  endAll(timeoutSeconds: number): Promise<void>;
}

/**
 * Drizzle's postgres-js driver replaces the client's date, time and JSON
 * parsers and serializers once, when the database is constructed. A
 * replacement client must carry the same handlers or rows would change shape.
 */
function copyTypeHandlers(from: ClientShape, to: ClientShape): void {
  const source = from.options;
  const target = to.options;
  if (!source || !target) return;
  if (source.parsers && target.parsers) {
    Object.assign(target.parsers, source.parsers);
  }
  if (source.serializers && target.serializers) {
    Object.assign(target.serializers, source.serializers);
  }
}

function endClient(
  client: ClientShape,
  timeoutSeconds: number,
): Promise<DrainOutcome> {
  return Promise.resolve()
    .then(() => client.end?.({ timeout: timeoutSeconds }))
    .then(
      () => 'ended' as const,
      () => 'failed' as const,
    );
}

/**
 * Wraps postgres.js clients behind one handle so the pool can be replaced in
 * process. Every property read and call resolves against the current client
 * at that moment, so code holding the handle (Drizzle's session, the
 * statement deadlines, the request instrumentation) moves to the new client
 * with its next statement. A transaction keeps the client it began on.
 *
 * The first client is created on first use, so a module whose database
 * handle is replaced (as in tests) never builds or connects one.
 */
export function createSwappableClient<T extends object>(
  create: (generation: number) => T,
): SwappableClient<T> {
  let generation = 1;
  let created: T | undefined;
  const current = (): T => (created ??= create(generation));
  const draining = new Set<T>();

  // An arrow function target keeps the handle callable, like the driver's
  // tagged template, without a non-configurable `prototype` to trip over.
  const target = (() => undefined) as unknown as T;
  const client = new Proxy(target, {
    get(_target, property) {
      const active = current();
      const value: unknown = Reflect.get(active, property, active);
      return typeof value === 'function'
        ? ((value as (...args: unknown[]) => unknown).bind(active) as unknown)
        : value;
    },
    has(_target, property) {
      return Reflect.has(current(), property);
    },
    apply(_target, thisArg, args: unknown[]) {
      return Reflect.apply(
        current() as unknown as (...values: unknown[]) => unknown,
        thisArg,
        args,
      );
    },
  });

  return {
    client,
    get generation() {
      return generation;
    },
    replace(drainTimeoutSeconds) {
      const previous = current();
      const next = create(generation + 1);
      copyTypeHandlers(previous as ClientShape, next as ClientShape);
      generation += 1;
      created = next;
      draining.add(previous);
      const drained = endClient(
        previous as ClientShape,
        drainTimeoutSeconds,
      ).finally(() => draining.delete(previous));
      return { generation, drained };
    },
    async endAll(timeoutSeconds) {
      const clients = created ? [created, ...draining] : [...draining];
      await Promise.all(
        clients.map((each) => endClient(each as ClientShape, timeoutSeconds)),
      );
    },
  };
}
