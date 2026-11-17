/**
 * One-off backfill of `billing_free_plan_claims.phone_hash` for claims made
 * before the free plan was limited per WhatsApp number.
 *
 * Each claim without a hash takes its store's current
 * `merchant_whatsapp_phone`, hashed with FREE_PLAN_CLAIM_PHONE_KEY exactly as
 * the API hashes it. Claims are taken oldest first: when a number already
 * belongs to an earlier claim, the later claim is left without a hash and
 * counted as `duplicate` (that store keeps its claim; the number just cannot
 * claim again). Claims whose store is gone or has no number stay domain-only.
 *
 * Run with `npm run backfill:free-plan-claim-phones` (dry run, writes
 * nothing) and `npm run backfill:free-plan-claim-phones -- --apply`. Reads
 * DATABASE_URL and FREE_PLAN_CLAIM_PHONE_KEY from `.env`, or
 * `.env.<NODE_ENV>`; the key must be the one the API runs with. Output holds
 * counts only, never numbers or hashes. Safe to re-run.
 */
import dotenv from 'dotenv';
import postgres from 'postgres';
import { hashClaimPhone } from '../src/shared/billing/free-plan-claim-phone';
import {
  FREE_PLAN_CLAIM_PHONE_KEY_MIN_LENGTH,
  FREE_PLAN_CLAIM_PHONE_KEY_VAR,
} from '../src/shared/config/env-validation';

export interface FreePlanClaimPhoneBackfillResult {
  scanned: number;
  updated: number;
  duplicate: number;
  noPhone: number;
}

interface ClaimRow {
  [key: string]: unknown;
  id: string;
  phone: string | null;
}

export async function backfillFreePlanClaimPhones(
  sql: postgres.Sql,
  options: { apply: boolean; key: string },
): Promise<FreePlanClaimPhoneBackfillResult> {
  const result: FreePlanClaimPhoneBackfillResult = {
    scanned: 0,
    updated: 0,
    duplicate: 0,
    noPhone: 0,
  };

  const taken = new Set(
    (
      await sql<{ phone_hash: string }[]>`
        SELECT phone_hash FROM billing_free_plan_claims
        WHERE phone_hash IS NOT NULL`
    ).map((row) => row.phone_hash),
  );

  const claims = await sql<ClaimRow[]>`
    SELECT c.id, store.phone
    FROM billing_free_plan_claims c
    LEFT JOIN LATERAL (
      SELECT i.merchant_whatsapp_phone AS phone
      FROM integrations i
      WHERE i.platform_type = c.platform_type
        AND lower(trim(i.platform_store_url)) = c.shop_domain
        AND i.merchant_whatsapp_phone IS NOT NULL
      LIMIT 1
    ) store ON true
    WHERE c.phone_hash IS NULL
    ORDER BY c.claimed_at ASC NULLS LAST, c.id ASC`;

  for (const claim of claims) {
    result.scanned += 1;
    const phoneHash = claim.phone
      ? hashClaimPhone(claim.phone, options.key)
      : null;
    if (!phoneHash) {
      result.noPhone += 1;
      continue;
    }
    if (taken.has(phoneHash)) {
      result.duplicate += 1;
      continue;
    }
    taken.add(phoneHash);
    if (!options.apply) {
      result.updated += 1;
      continue;
    }
    try {
      const updated = await sql`
        UPDATE billing_free_plan_claims
        SET phone_hash = ${phoneHash}, updated_at = now()
        WHERE id = ${claim.id} AND phone_hash IS NULL`;
      result.updated += updated.count;
    } catch (error) {
      // A claim made by the API since the scan took the number first.
      if ((error as { code?: string }).code === '23505') {
        result.duplicate += 1;
        continue;
      }
      throw error;
    }
  }

  return result;
}

async function main(): Promise<void> {
  dotenv.config({
    path: process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env',
    quiet: true,
  });
  const databaseUrl =
    process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const key = process.env[FREE_PLAN_CLAIM_PHONE_KEY_VAR]?.trim();
  if (!key || key.length < FREE_PLAN_CLAIM_PHONE_KEY_MIN_LENGTH) {
    throw new Error(
      `${FREE_PLAN_CLAIM_PHONE_KEY_VAR} must be set to the API's key (at least ${FREE_PLAN_CLAIM_PHONE_KEY_MIN_LENGTH} characters)`,
    );
  }

  const apply = process.argv.includes('--apply');
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const result = await backfillFreePlanClaimPhones(sql, { apply, key });
    console.log(
      `[backfill-free-plan-claim-phones] ${apply ? '' : 'dry run: '}` +
        `scanned=${result.scanned} updated=${result.updated} ` +
        `duplicate=${result.duplicate} noPhone=${result.noPhone}`,
    );
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `[backfill-free-plan-claim-phones] failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
