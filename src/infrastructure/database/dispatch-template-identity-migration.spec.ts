import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('dispatch template identity migration contract', () => {
  const sql = readFileSync(
    resolve(__dirname, '../../../drizzle/0053_dispatch_template_identity.sql'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const statements = sql
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
  const journal = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../drizzle/meta/_journal.json'),
      'utf8',
    ),
  ) as { entries: { idx: number; tag: string }[] };

  const columns = [
    'template_variant_key',
    'template_purpose',
    'meta_template_name',
    'meta_language_code',
    'resolved_language',
  ];

  it('is registered as journal entry 53', () => {
    expect(journal.entries.find((entry) => entry.idx === 53)).toMatchObject({
      tag: '0053_dispatch_template_identity',
    });
  });

  it.each(columns)('adds %s as a nullable column with no default', (column) => {
    expect(statements).toContain(
      `ALTER TABLE "verification_message_dispatches" ADD COLUMN IF NOT EXISTS "${column}" text;`,
    );
  });

  it('never rewrites, backfills or removes an existing row or column', () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(
        /^\s*(UPDATE|DELETE|INSERT|TRUNCATE)\b|\bDROP\s+(COLUMN|TABLE)\b|\bSET\s+NOT\s+NULL\b|\bSET\s+DEFAULT\b/i,
      );
    }
  });

  it('only allows the three purposes and the two languages, or nothing', () => {
    expect(sql).toContain(
      `CHECK ("template_purpose" IS NULL OR "template_purpose" IN ('initial', 'reminder', 'test'))`,
    );
    expect(sql).toContain(
      `CHECK ("resolved_language" IS NULL OR "resolved_language" IN ('ar', 'en'))`,
    );
  });

  it('indexes accepted dispatches for the metrics range', () => {
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_verification_message_dispatches_accepted_at" ON "verification_message_dispatches" USING btree ("accepted_at") WHERE "accepted_at" IS NOT NULL;',
    );
  });

  it('drops the misleading verification defaults and nothing else there', () => {
    const onVerifications = statements.filter((statement) =>
      statement.startsWith('ALTER TABLE "verifications"'),
    );
    expect(onVerifications).toEqual([
      'ALTER TABLE "verifications" ALTER COLUMN "template_name" DROP DEFAULT;',
      'ALTER TABLE "verifications" ALTER COLUMN "language_code" DROP DEFAULT;',
    ]);
  });

  it('is safe to replay and documents its rollback', () => {
    for (const statement of statements) {
      expect(statement).toMatch(
        /IF NOT EXISTS|IF EXISTS|ADD CONSTRAINT|DROP DEFAULT/,
      );
    }
    expect(sql).toContain('-- Rollback:');
  });
});
