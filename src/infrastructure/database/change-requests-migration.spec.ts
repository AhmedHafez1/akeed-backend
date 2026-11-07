import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('change requests migration contract', () => {
  const sql = readFileSync(
    resolve(__dirname, '../../../drizzle/0092_change_requests.sql'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const journal = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../drizzle/meta/_journal.json'),
      'utf8',
    ),
  ) as { entries: { idx: number; tag: string }[] };

  it('is registered in the journal', () => {
    expect(
      journal.entries.find((entry) => entry.tag === '0092_change_requests'),
    ).toMatchObject({ idx: 93 });
  });

  it('starts every store with the feature off and every order in cycle 1', () => {
    expect(sql).toContain(
      'ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "change_requests_enabled" boolean DEFAULT false NOT NULL;',
    );
    expect(sql).toContain(
      'ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "confirmation_cycle" integer DEFAULT 1 NOT NULL;',
    );
    expect(sql).toContain(
      'ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "confirmation_cycle" integer DEFAULT 1 NOT NULL;',
    );
  });

  it('is additive: no existing row is rewritten or removed', () => {
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/^\s*UPDATE\b/m);
    expect(statements).not.toMatch(/^\s*DELETE\b/m);
    expect(statements).not.toMatch(/DROP (TABLE|COLUMN)/);
  });

  it('allows one open request per verification and one per cycle', () => {
    expect(sql).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "verification_change_requests_one_open" ON "verification_change_requests" USING btree ("verification_id") WHERE "status" = 'open';`,
    );
    expect(sql).toContain(
      'CONSTRAINT "verification_change_requests_cycle_key" UNIQUE ("verification_id", "confirmation_cycle")',
    );
  });

  it('binds every row to its tenant through composite keys', () => {
    for (const reference of [
      'REFERENCES "verifications"("id", "org_id")',
      'REFERENCES "orders"("id", "org_id")',
      'REFERENCES "integrations"("id", "org_id")',
      'REFERENCES "verification_message_dispatches"("id", "org_id")',
      'REFERENCES "verification_change_requests"("id", "org_id")',
    ])
      expect(sql).toContain(reference);
  });

  it('keeps the new tables away from client roles', () => {
    for (const table of [
      'verification_change_requests',
      'verification_change_request_events',
      'verification_change_request_effects',
    ]) {
      expect(sql).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      );
      expect(sql).toContain(
        `REVOKE ALL ON "${table}" FROM PUBLIC, anon, authenticated;`,
      );
    }
  });

  it('is safe to replay', () => {
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
  });
});
