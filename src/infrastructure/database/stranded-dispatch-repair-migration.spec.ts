import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('stranded dispatch send-facts repair migration contract', () => {
  // Normalize line endings: on a Windows checkout with `core.autocrlf=true`
  // the migration lands with CRLF, which would never match the multi-line
  // assertions below.
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../../drizzle/0030_repair_stranded_dispatch_send_facts.sql',
    ),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('repairs only sends the customer has already answered', () => {
    // A `sending`/`outcome_unknown` dispatch cannot itself prove a message went
    // out. The customer's reply can, so it is the only admissible evidence
    // here — anything looser would invent a send that never happened.
    expect(sql).toContain(
      `AND "verification"."status" IN ('confirmed', 'canceled')`,
    );
    expect(sql).toContain(
      `AND "dispatch"."state" IN ('sending', 'outcome_unknown')`,
    );
  });

  it('scopes to the initial send that owns these columns', () => {
    expect(sql).toContain(`AND "dispatch"."kind" = 'initial'`);
  });

  it('reports exactly what it wrote', () => {
    // A separate counting query can disagree with the write it claims to
    // describe; reading ROW_COUNT back off the UPDATE cannot.
    expect(sql).toContain('GET DIAGNOSTICS repaired_count = ROW_COUNT;');
  });

  it('is idempotent', () => {
    // Only rows still missing the fact are touched, and the attempt count is
    // raised rather than replaced, so a re-run cannot lower a real value.
    expect(sql).toContain(`AND "verification"."last_sent_at" IS NULL`);
    expect(sql).toContain(
      `"attempts" = GREATEST(COALESCE("verification"."attempts", 0), "dispatch"."attempt_count")`,
    );
  });

  it('never rewrites the status or invents a provider message id', () => {
    // The customer's reply is the final word on `status`, and the lost wamid
    // must stay NULL — a fabricated one would misdirect the delivery and read
    // webhooks, which resolve receipts by that id.
    expect(sql).not.toContain('"status" =');
    expect(sql).not.toContain('"wa_message_id" =');
  });
});
