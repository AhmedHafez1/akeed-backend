import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('verification status repair migration contract', () => {
  // Normalize line endings: on a Windows checkout with `core.autocrlf=true`
  // the migration lands with CRLF, which would never match the multi-line
  // assertions below.
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../../drizzle/0029_repair_verification_status_from_dispatch_ledger.sql',
    ),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('only repairs rows that are still claiming nothing was sent', () => {
    // A customer's own reply outranks the ledger, so `confirmed`/`canceled`
    // rows must be out of scope by construction rather than by luck.
    expect(sql).toContain(
      `AND (verification."status" IS NULL OR verification."status" = 'pending')`,
    );
  });

  it('repairs only against provable acceptance', () => {
    expect(sql).toContain(`WHERE dispatch."state" = 'accepted'`);
    expect(sql).toContain(`AND dispatch."provider_message_id" IS NOT NULL`);
  });

  it('advances to the furthest state the ledger can prove', () => {
    expect(sql).toContain(
      `WHEN ledger.read_at      IS NOT NULL THEN 'read'::verification_status`,
    );
    expect(sql).toContain(
      `WHEN ledger.delivered_at IS NOT NULL THEN 'delivered'::verification_status`,
    );
    expect(sql).toContain(`ELSE 'sent'::verification_status`);
  });

  it('never overwrites a timestamp the row already carries', () => {
    for (const column of [
      'last_sent_at',
      'delivered_at',
      'read_at',
      'wa_message_id',
    ]) {
      expect(sql).toContain(`COALESCE(verification."${column}"`);
    }
  });

  it('restores the wamid the webhook path resolves receipts by', () => {
    // Without this, delivery and read callbacks for a repaired row would still
    // match zero verifications and be dropped.
    expect(sql).toContain(
      `"wa_message_id"  = COALESCE(verification."wa_message_id", ledger.provider_message_id)`,
    );
  });

  it('takes the earliest acceptance as the first send', () => {
    expect(sql).toContain(`min(dispatch."accepted_at")  AS accepted_at`);
  });

  it('closes the NULL hole the read path used to launder into pending', () => {
    expect(sql).toContain(
      `UPDATE "public"."verifications" SET "status" = 'pending' WHERE "status" IS NULL;`,
    );
    expect(sql).toContain(`ALTER COLUMN "status" SET NOT NULL`);
    // NOT NULL must come after the repair, or it would fail on existing NULLs.
    expect(sql.indexOf(`ALTER COLUMN "status" SET NOT NULL`)).toBeGreaterThan(
      sql.indexOf(`ELSE 'sent'::verification_status`),
    );
  });

  it('reports drift before and after so the repair is auditable', () => {
    expect(sql).toContain(
      'verification status repair preflight: drifted_rows=%',
    );
    expect(sql).toContain('verification status repair: remaining_drift=%');
  });
});
