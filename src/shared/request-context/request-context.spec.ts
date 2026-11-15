import {
  createRequestContext,
  currentRequestContext,
  dbCounters,
  recallAuthIntegration,
  recordQuery,
  recordTransaction,
  rememberAuthIntegration,
  runRequestContext,
  noteConnection,
  noteConnectionClosed,
  connectionsOpenedSince,
} from './request-context';

const integration = {
  id: 'int-1',
  orgId: 'org-1',
  platformType: 'shopify',
  platformStoreUrl: 'synthetic.myshopify.com',
} as never;

describe('request context', () => {
  it('counts reused pool ids again after a close without counting ordinary reuse', () => {
    const context = createRequestContext();
    noteConnection(90001);
    noteConnection(90001);
    expect(connectionsOpenedSince(context)).toBe(1);
    noteConnectionClosed(90001);
    expect(connectionsOpenedSince(context)).toBe(1);
    noteConnection(90001);
    expect(connectionsOpenedSince(context)).toBe(2);
    const warm = createRequestContext();
    noteConnection(90001);
    expect(connectionsOpenedSince(warm)).toBe(0);
    noteConnectionClosed(90001);
  });
  it('reports nothing and records nothing outside a request', () => {
    expect(currentRequestContext()).toBeUndefined();
    recordQuery('select 1', 5);
    recordTransaction();
    rememberAuthIntegration(integration);
    expect(dbCounters()).toEqual({});
    expect(recallAuthIntegration()).toBeUndefined();
  });

  it('keeps the counters of interleaved requests apart', async () => {
    const first = createRequestContext('req-1');
    const second = createRequestContext('req-2');
    await Promise.all([
      runRequestContext(first, async () => {
        recordQuery('select 1', 10);
        await Promise.resolve();
        recordQuery('select 2', 30);
      }),
      runRequestContext(second, async () => {
        await Promise.resolve();
        recordQuery('update integrations set x = 1', 7);
        expect(dbCounters()).toMatchObject({ dbQueryCount: 1, dbWrites: 1 });
      }),
    ]);
    expect(first.db).toEqual({
      count: 2,
      totalMs: 40,
      maxMs: 30,
      writes: 0,
      transactions: 0,
    });
    expect(second.db).toMatchObject({ count: 1, totalMs: 7, writes: 1 });
    expect(first.requestId).toBe('req-1');
  });

  it('counts a transaction as a write and rounds the log fields', () => {
    const context = createRequestContext();
    runRequestContext(context, () => {
      recordQuery('  SELECT 1', 1.26);
      recordTransaction();
      expect(dbCounters()).toEqual({
        dbQueryCount: 1,
        dbTotalMs: 1,
        dbMaxMs: 1,
        dbWrites: 1,
        dbTransactions: 1,
        dbNewConnections: 0,
      });
    });
  });

  it('recalls the auth integration only until the request writes', () => {
    runRequestContext(createRequestContext(), () => {
      rememberAuthIntegration(integration);
      recordQuery('select 1', 1);
      expect(recallAuthIntegration()).toBe(integration);
      recordQuery('insert into x values (1)', 1);
      expect(recallAuthIntegration()).toBeUndefined();
    });
  });

  it('treats a CTE as a write, conservatively', () => {
    runRequestContext(createRequestContext(), () => {
      rememberAuthIntegration(integration);
      recordQuery('with rows as (select 1) select * from rows', 1);
      expect(recallAuthIntegration()).toBeUndefined();
    });
  });
});
