import { AsyncLocalStorage } from 'node:async_hooks';
import type { integrations } from '../../infrastructure/database/schema';

type IntegrationRecord = typeof integrations.$inferSelect;

/**
 * Per-request accounting for the database work a request waits on. Every
 * number is a duration or a count: nothing here identifies a tenant, a
 * statement or a row, so the counters can go straight into logs and the
 * `Server-Timing` header.
 */
export interface RequestDbCounters {
  /** Statements issued through the instrumented client. */
  count: number;
  /** Milliseconds from issuing a statement to its settling, pool wait included. */
  totalMs: number;
  maxMs: number;
  /** Statements that were not plain `select`s (conservative: CTEs count). */
  writes: number;
  transactions: number;
}

export interface RequestContext {
  requestId?: string;
  startedAt: number;
  /** Set by the auth guard once the token has been validated. */
  authMs?: number;
  handlerStartedAt?: number;
  handlerMs?: number;
  db: RequestDbCounters;
  /** Pooled connections the process had opened when the request began. */
  connectionsAtStart: number;
  /**
   * The integration row the auth guard loaded. Handlers may reuse it only
   * through {@link recallAuthIntegration}, which refuses once the request has
   * written anything, so a handler never reads a row it has just changed.
   */
  authIntegration?: IntegrationRecord;
}

const storage = new AsyncLocalStorage<RequestContext>();
const seenConnections = new Set<number>();
let connectionGenerations = 0;

export function createRequestContext(requestId?: string): RequestContext {
  return {
    requestId,
    startedAt: Date.now(),
    db: { count: 0, totalMs: 0, maxMs: 0, writes: 0, transactions: 0 },
    connectionsAtStart: connectionGenerations,
  };
}

export function runRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

function isReadStatement(statement: string): boolean {
  return statement.trimStart().slice(0, 6).toLowerCase() === 'select';
}

/** Records one settled statement on the active request; a no-op elsewhere. */
export function recordQuery(statement: string, elapsedMs: number): void {
  const context = storage.getStore();
  if (context) recordQueryOn(context, statement, elapsedMs);
}

/** Records a settled statement on `context`, whichever request is active now. */
export function recordQueryOn(
  context: RequestContext,
  statement: string,
  elapsedMs: number,
): void {
  context.db.count += 1;
  context.db.totalMs += elapsedMs;
  if (elapsedMs > context.db.maxMs) context.db.maxMs = elapsedMs;
  if (!isReadStatement(statement)) context.db.writes += 1;
}

export function recordTransaction(): void {
  const context = storage.getStore();
  if (!context) return;
  context.db.transactions += 1;
  // A transaction writes until proven otherwise.
  context.db.writes += 1;
}

/** First statement on an open connection generation; never retains SQL or parameters. */
export function noteConnection(connectionId: number): void {
  if (seenConnections.has(connectionId)) return;
  seenConnections.add(connectionId);
  connectionGenerations += 1;
}

/** postgres.js reuses the same pool slot id when its socket reconnects. */
export function noteConnectionClosed(connectionId: number): void {
  seenConnections.delete(connectionId);
}

export function connectionsOpenedSince(context: RequestContext): number {
  return Math.max(0, connectionGenerations - context.connectionsAtStart);
}

/** Numeric log fields for the active request, or nothing outside one. */
export function dbCounters(): Record<string, number> {
  const context = storage.getStore();
  if (!context) return {};
  return {
    dbQueryCount: context.db.count,
    dbTotalMs: Math.round(context.db.totalMs),
    dbMaxMs: Math.round(context.db.maxMs),
    dbWrites: context.db.writes,
    dbTransactions: context.db.transactions,
    dbNewConnections: connectionsOpenedSince(context),
  };
}

export function rememberAuthIntegration(row: IntegrationRecord): void {
  const context = storage.getStore();
  if (context) context.authIntegration = row;
}

/**
 * The integration the guard loaded for this request, unless the request has
 * since written to the database. Callers must still check that the row is the
 * one they want (same org, same store); this only saves the round trip.
 */
export function recallAuthIntegration(): IntegrationRecord | undefined {
  const context = storage.getStore();
  if (!context || context.db.writes > 0) return undefined;
  return context.authIntegration;
}
