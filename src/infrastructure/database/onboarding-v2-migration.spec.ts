import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('onboarding v2 migration contract', () => {
  const sql = readFileSync(
    resolve(__dirname, '../../../drizzle/0042_onboarding_v2.sql'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const journal = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../drizzle/meta/_journal.json'),
      'utf8',
    ),
  ) as { entries: { idx: number; tag: string }[] };

  it('is registered as the next journal entry', () => {
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 42,
      tag: '0042_onboarding_v2',
    });
  });

  it('only adds nullable columns, so existing stores are untouched', () => {
    for (const column of [
      'merchant_whatsapp_phone',
      'shop_phone',
      'setup_completed_at',
      'test_sent_at',
      'test_confirmed_at',
      'test_skipped_at',
      'first_real_confirmed_at',
      'credits_80_at',
    ]) {
      expect(sql).toMatch(
        new RegExp(`ADD COLUMN IF NOT EXISTS "${column}" [a-z ]+;`),
      );
    }
    expect(sql).not.toMatch(/\bUPDATE\b/);
  });

  it('keeps product events tenant-safe and service-role only', () => {
    expect(sql).toContain(
      'FOREIGN KEY ("integration_id", "org_id") REFERENCES "integrations"("id", "org_id") ON DELETE cascade',
    );
    expect(sql).toContain(
      'ALTER TABLE "product_events" ENABLE ROW LEVEL SECURITY',
    );
    expect(sql).toContain('ON "product_events" FOR ALL TO service_role');
  });
});
