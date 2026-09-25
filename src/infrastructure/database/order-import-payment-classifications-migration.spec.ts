import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('order import payment classifications migration contract', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../../drizzle/0044_order_import_payment_classifications.sql',
    ),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const journal = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../drizzle/meta/_journal.json'),
      'utf8',
    ),
  ) as { entries: { idx: number; tag: string }[] };

  it('is registered as journal entry 44', () => {
    expect(journal.entries.find((entry) => entry.idx === 44)).toMatchObject({
      tag: '0044_order_import_payment_classifications',
    });
  });

  it('adds one table and never rewrites existing rows', () => {
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "order_import_payment_classifications"',
    );
    expect(sql).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|ALTER TABLE "(?!order_import_payment_classifications)/,
    );
  });

  it('keys one choice per organization and value, COD or not', () => {
    expect(sql).toContain('PRIMARY KEY ("org_id", "normalized_value")');
    expect(sql).toContain(`CHECK ("classification" IN ('cod', 'not_cod'))`);
    expect(sql).toContain('ON DELETE CASCADE');
  });

  it('is tenant-scoped under RLS and safe to replay', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'USING (org_id = get_user_org_id()) WITH CHECK (org_id = get_user_org_id())',
    );
    expect(sql).toContain(
      'DROP POLICY IF EXISTS "Multi-tenant order import payment classifications"',
    );
  });
});
