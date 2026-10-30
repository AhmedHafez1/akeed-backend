/**
 * Re-runs stored Shopify `customers/redact` requests through today's
 * redaction, for requests that an older handler skipped (it needed a phone).
 *
 * Each request's stored payload still holds the customer id (and email or
 * phone when Shopify sent them); the same match and scrub the webhook uses is
 * applied, and the request row is reduced to its ids. Re-running is safe: a
 * redacted customer matches nothing. It never scans every store, because an
 * old request re-run today could anonymise orders a returning customer placed
 * since.
 *
 * Run with `npm run replay:shopify-customer-redactions -- --store-domain
 * <shop>.myshopify.com [--since 2026-10-01]` or `-- --event-id <uuid>`
 * (reads DATABASE_URL from `.env`, or `.env.<NODE_ENV>`). It only counts
 * unless `--apply` is given. Output holds counts and ids, never customer data.
 */
import dotenv from 'dotenv';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import {
  hasShopifyCustomerKeys,
  OrdersRepository,
  type ShopifyCustomerRedactionResult,
} from '../src/infrastructure/database/repositories/orders.repository';
import { WebhookEventsRepository } from '../src/infrastructure/database/repositories/webhook-events.repository';
import { buildShopifyCustomerKeys } from '../src/infrastructure/spokes/shopify/services/shopify-customer-keys';
import { PhoneService } from '../src/shared/services/phone.service';

type ReplayDb = PostgresJsDatabase<typeof schema>;

export interface ReplayOptions {
  storeDomain?: string;
  since?: string;
  eventId?: string;
  apply?: boolean;
}

export interface ReplayEventResult extends ShopifyCustomerRedactionResult {
  webhookEventId: string;
  storeDomain: string;
  outcome: 'redacted' | 'would_redact' | 'no_identifiers' | 'no_integration';
}

interface StoredRedactPayload {
  customer?: { id?: string | number; email?: string; phone?: string };
  orders_to_redact?: Array<string | number>;
}

export async function replayShopifyCustomerRedactions(
  db: ReplayDb,
  options: ReplayOptions,
): Promise<ReplayEventResult[]> {
  if (!options.storeDomain && !options.eventId) {
    throw new Error('Pass --store-domain or --event-id');
  }

  const ordersRepo = new OrdersRepository(db);
  const webhookEventsRepo = new WebhookEventsRepository(db);
  const phoneService = new PhoneService();

  const events = await webhookEventsRepo.findShopifyCustomerRedactions({
    storeDomain: options.storeDomain,
    since: options.since,
    eventId: options.eventId,
  });

  const results: ReplayEventResult[] = [];
  for (const event of events) {
    const base = {
      webhookEventId: event.id,
      storeDomain: event.storeDomain,
      orders: 0,
      verifications: 0,
      webhookEvents: 0,
    };
    if (!event.orgId || !event.integrationId) {
      results.push({ ...base, outcome: 'no_integration' });
      continue;
    }

    const payload = (event.rawPayload ?? {}) as StoredRedactPayload;
    const keys = buildShopifyCustomerKeys(
      payload.customer,
      payload.orders_to_redact,
      phoneService,
    );
    if (!hasShopifyCustomerKeys(keys)) {
      results.push({ ...base, outcome: 'no_identifiers' });
      continue;
    }

    const counts = await ordersRepo.redactShopifyCustomer(
      event.orgId,
      event.integrationId,
      keys,
      { dryRun: !options.apply },
    );
    if (options.apply) {
      await webhookEventsRepo.replaceRawPayload(event.id, {
        customer: { id: keys.customerId ?? null },
        orders_to_redact: keys.externalOrderIds,
      });
    }
    results.push({
      ...base,
      ...counts,
      outcome: options.apply ? 'redacted' : 'would_redact',
    });
  }

  return results;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  dotenv.config({
    path: process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env',
    quiet: true,
  });
  const databaseUrl =
    process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const options: ReplayOptions = {
    storeDomain: argValue('--store-domain'),
    since: argValue('--since'),
    eventId: argValue('--event-id'),
    apply: process.argv.includes('--apply'),
  };
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const results = await replayShopifyCustomerRedactions(
      drizzle(client, { schema }),
      options,
    );
    for (const result of results) {
      console.log(
        `[replay-shopify-customer-redactions] event=${result.webhookEventId} ` +
          `store=${result.storeDomain} outcome=${result.outcome} ` +
          `orders=${result.orders} verifications=${result.verifications} ` +
          `webhookEvents=${result.webhookEvents}`,
      );
    }
    console.log(
      `[replay-shopify-customer-redactions] ${
        options.apply ? 'applied' : 'dry run (add --apply to write)'
      }: events=${results.length}`,
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `[replay-shopify-customer-redactions] failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
