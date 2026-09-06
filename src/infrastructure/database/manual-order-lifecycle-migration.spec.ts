import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('US-04-03 migration contract', () => {
  // Normalize line endings: on a Windows checkout with `core.autocrlf=true`
  // the migration lands with CRLF, which would never match the multi-line
  // assertions below.
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../../drizzle/0028_manual_order_lifecycle_dispatch_ledger.sql',
    ),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('links only matching Standalone manual events through tenant-safe identity', () => {
    expect(sql).toContain(`event."platform" = 'standalone'`);
    expect(sql).toContain(`event."job_type" = 'order.create'`);
    expect(sql).toContain(`event."org_id" = matched_order."org_id"`);
    expect(sql).toContain(
      `event."integration_id" = matched_order."integration_id"`,
    );
    expect(sql).toContain(
      `FOREIGN KEY ("order_id", "org_id")\n      REFERENCES "public"."orders"("id", "org_id")`,
    );
  });

  it('backfills provider ids without inventing initial or follow-up identity', () => {
    expect(sql).toContain(`verification."wa_message_id" IS NOT NULL`);
    expect(sql).toContain(`'legacy_unknown'`);
    expect(sql).toContain(`'accepted'`);
    expect(sql).toContain(`ON CONFLICT ("dispatch_key") DO NOTHING`);
  });

  it('keeps dispatch ownership tenant-safe across source and verification links', () => {
    expect(sql).toContain(
      `FOREIGN KEY ("verification_id", "org_id") REFERENCES "public"."verifications"("id", "org_id")`,
    );
    expect(sql).toContain(
      `FOREIGN KEY ("integration_id", "org_id") REFERENCES "public"."integrations"("id", "org_id")`,
    );
  });

  it('is safe to reapply and reports preflight and post-backfill counts', () => {
    expect(sql).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "order_id"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(sql).toContain('US-04-03 preflight:');
    expect(sql).toContain('US-04-03 backfill:');
  });

  it('requeues only the previously blocked, now-linkable manual events', () => {
    expect(sql).toContain(`"last_error" = 'no_normalizer:standalone'`);
    expect(sql).toContain(`"order_id" IS NOT NULL`);
    expect(sql).toContain(`"status" = 'pending'`);
  });
});
