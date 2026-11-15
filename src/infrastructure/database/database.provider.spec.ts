import { buildPoolOptions, usesTransactionPooler } from './database.provider';

const TRANSACTION_POOLER =
  'postgresql://user:pass@aws-0-eu-west-1.pooler.supabase.com:6543/postgres';
const SESSION_POOLER =
  'postgresql://user:pass@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';

describe('database pool options', () => {
  it('detects the transaction pooler by port or flag', () => {
    expect(usesTransactionPooler(TRANSACTION_POOLER)).toBe(true);
    expect(
      usesTransactionPooler('postgresql://u:p@host:5432/db?pgbouncer=true'),
    ).toBe(true);
    expect(usesTransactionPooler(SESSION_POOLER)).toBe(false);
    expect(usesTransactionPooler('not a url')).toBe(false);
  });

  it('preserves idle defaults on the transaction pooler and disables prepared statements', () => {
    expect(buildPoolOptions(TRANSACTION_POOLER, {})).toEqual({
      transactionPooler: true,
      prepare: false,
      max: 10,
      idle_timeout: 20,
    });
  });

  it('releases idle connections quickly on the session pooler', () => {
    expect(buildPoolOptions(SESSION_POOLER, {})).toMatchObject({
      transactionPooler: false,
      prepare: true,
      idle_timeout: 20,
    });
  });

  it('honours valid overrides and ignores invalid ones', () => {
    expect(
      buildPoolOptions(TRANSACTION_POOLER, {
        DATABASE_POOL_MAX: '4',
        DATABASE_IDLE_TIMEOUT_SECONDS: '45',
      }),
    ).toMatchObject({ max: 4, idle_timeout: 45 });
    expect(
      buildPoolOptions(SESSION_POOLER, {
        DATABASE_POOL_MAX: '0',
        DATABASE_IDLE_TIMEOUT_SECONDS: 'soon',
      }),
    ).toMatchObject({ max: 10, idle_timeout: 20 });
  });
});
