import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('verification confirmation source migration contract', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../../drizzle/0043_verification_confirmation_source.sql',
    ),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const journal = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../drizzle/meta/_journal.json'),
      'utf8',
    ),
  ) as { entries: { idx: number; tag: string }[] };

  it('is registered as journal entry 43', () => {
    expect(journal.entries.find((entry) => entry.idx === 43)).toMatchObject({
      idx: 43,
      tag: '0043_verification_confirmation_source',
    });
  });

  it('adds a nullable column and never rewrites existing rows', () => {
    expect(sql).toContain(
      'ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "confirmation_source" text;',
    );
    expect(sql).not.toMatch(/NOT NULL/);
    expect(sql).not.toMatch(/\bUPDATE\b/);
  });

  it('accepts only the two known sources', () => {
    expect(sql).toContain(
      `CHECK ("confirmation_source" IS NULL OR "confirmation_source" IN ('customer', 'merchant_manual'))`,
    );
  });

  it('is safe to replay', () => {
    expect(sql).toContain('WHEN duplicate_object THEN null;');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_orders_org_order_number"',
    );
  });
});
