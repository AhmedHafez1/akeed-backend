import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';

/**
 * The store whose data is removed. `platform` + `storeDomain` are the source
 * identity webhook rows are keyed by, so rows that never learned their org or
 * order are still found.
 */
export interface StoreIdentity {
  orgId: string;
  integrationId: string;
  platform: string;
  storeDomain: string;
}

export interface StoreDataDeletionOptions {
  /**
   * `store`: one store's customer data; the integration and organization stay
   * (uninstall: a reinstall reuses them). `organization`: everything the
   * organization owns, the account rows included (`shop/redact`).
   */
  scope: 'store' | 'organization';
  /**
   * The request row of the webhook driving this deletion. It is detached from
   * the organization instead of deleted, so a redelivery is still answered as
   * a duplicate; it holds no customer data, and retention removes it later.
   */
  keepWebhookEventId?: string;
}

export interface StoreDataDeletionCounts {
  metaWebhookEvents: number;
  providerMessageReceipts: number;
  webhookEvents: number;
  verifications: number;
  messageDispatches: number;
  orderImportBatches: number;
  orders: number;
  integrationMonthlyUsage: number;
  integrations: number;
  memberships: number;
  organizations: number;
}

export class StoreDataDeletionBlockedError extends Error {
  constructor(readonly reason: 'credit_records') {
    super(`Store data deletion blocked: ${reason}`);
    this.name = 'StoreDataDeletionBlockedError';
  }
}

/** Shopify GDPR request rows: the record of a request, reduced to ids. */
export const GDPR_WEBHOOK_JOB_TYPES = [
  'customers/redact',
  'customers/data_request',
  'shop/redact',
] as const;

type Executor = Pick<DrizzleDB, 'execute'>;
type Transaction = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

export type UninstalledStoreDeletionResult =
  | { outcome: 'deleted'; counts: StoreDataDeletionCounts }
  | {
      outcome: 'skipped';
      /**
       * `not_found`: already deleted (the job or an earlier redact ran).
       * `reinstalled`: the store is active again and keeps its data.
       * `not_due`: the 48-hour window has not closed (job only).
       */
      reason: 'not_found' | 'reinstalled' | 'not_due';
    };

async function count(tx: Executor, statement: SQL): Promise<number> {
  const rows = await tx.execute(
    sql`WITH affected AS (${statement}) SELECT count(*)::int AS n FROM affected`,
  );
  return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
}

/**
 * The single routine that removes a store's customer data.
 *
 * Every table is matched by org / integration / source identity, never only
 * through `order_id`: a webhook row that never linked to its order still holds
 * the full order payload. Children reached by FK cascade (confirmed in the
 * migrations) are listed at each step. Each step is a plain filtered DELETE in
 * one transaction, so a rerun finds nothing and returns zeros.
 */
@Injectable()
export class StoreDataDeletionRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async deleteStoreData(
    store: StoreIdentity,
    options: StoreDataDeletionOptions,
  ): Promise<StoreDataDeletionCounts> {
    return this.db.transaction((tx) =>
      this.deleteInTransaction(tx, store, options),
    );
  }

  /**
   * Deletes an uninstalled Shopify store and its organization: the 48-hour
   * job and shop/redact both come here. The integration row is locked first,
   * so a reinstall (which updates that row) either commits before, and the
   * store is skipped, or waits until the data is gone. A store that is
   * active again is never touched; a store already deleted is a no-op.
   */
  async deleteUninstalledShopifyStore(
    store: StoreIdentity,
    options: { dueBefore?: string; keepWebhookEventId?: string } = {},
  ): Promise<UninstalledStoreDeletionResult> {
    return this.db.transaction(async (tx) => {
      // Organization first: a concurrent insert that references the store
      // (a webhook row) takes its FK locks in that order, so taking them in
      // the same order here cannot deadlock; the insert waits, then sees the
      // store gone.
      await tx.execute(sql`
        SELECT 1 FROM organizations WHERE id = ${store.orgId}::uuid FOR UPDATE`);
      const [current] = (await tx.execute(sql`
        SELECT is_active, uninstalled_at FROM integrations
        WHERE id = ${store.integrationId}::uuid AND org_id = ${store.orgId}::uuid
        FOR UPDATE`)) as unknown as Array<{
        is_active: boolean | null;
        uninstalled_at: string | Date | null;
      }>;
      if (!current) return { outcome: 'skipped', reason: 'not_found' };
      if (current.is_active !== false)
        return { outcome: 'skipped', reason: 'reinstalled' };
      if (options.dueBefore) {
        const uninstalledAt = current.uninstalled_at
          ? new Date(current.uninstalled_at).getTime()
          : null;
        if (
          uninstalledAt === null ||
          uninstalledAt > new Date(options.dueBefore).getTime()
        )
          return { outcome: 'skipped', reason: 'not_due' };
      }
      const counts = await this.deleteInTransaction(tx, store, {
        scope: 'organization',
        keepWebhookEventId: options.keepWebhookEventId,
      });
      return { outcome: 'deleted', counts };
    });
  }

  private async deleteInTransaction(
    tx: Transaction,
    store: StoreIdentity,
    options: StoreDataDeletionOptions,
  ): Promise<StoreDataDeletionCounts> {
    const { orgId, integrationId, platform, storeDomain } = store;
    const orgScope = options.scope === 'organization';
    const keepId = options.keepWebhookEventId ?? null;

    const ownedBy = (alias: string): SQL =>
      orgScope
        ? sql`${sql.raw(alias)}.org_id = ${orgId}::uuid`
        : sql`${sql.raw(alias)}.org_id = ${orgId}::uuid AND ${sql.raw(alias)}.integration_id = ${integrationId}::uuid`;

    const storeVerifications = sql`
      SELECT v.id FROM verifications v
      WHERE v.org_id = ${orgId}::uuid
        AND v.order_id IN (SELECT o.id FROM orders o WHERE ${ownedBy('o')})`;
    const storeDispatches = sql`
      SELECT d.id FROM verification_message_dispatches d
      WHERE d.org_id = ${orgId}::uuid
        AND (d.verification_id IN (${storeVerifications}) OR ${ownedBy('d')})`;

    {
      // Credit rows are financial records with NO ACTION FKs on dispatches and
      // accounts; deleting around them would either fail half-way or destroy
      // the ledger. Shopify stores are not prepaid, so this is a guard only.
      const blocked = await tx.execute(sql`
        SELECT 1 FROM credit_reservations WHERE dispatch_id IN (${storeDispatches})
        UNION ALL
        SELECT 1 FROM credit_ledger_entries WHERE dispatch_id IN (${storeDispatches})
        UNION ALL
        SELECT 1 FROM credit_accounts WHERE ${sql.raw(orgScope ? 'true' : 'false')} AND org_id = ${orgId}::uuid
        LIMIT 1`);
      if (blocked.length > 0)
        throw new StoreDataDeletionBlockedError('credit_records');

      const providerIds = (
        (await tx.execute(sql`
          SELECT provider_message_id AS id FROM verification_message_dispatches
            WHERE id IN (${storeDispatches}) AND provider_message_id IS NOT NULL
          UNION
          SELECT provider_message_id FROM verification_reply_events
            WHERE verification_id IN (${storeVerifications}) AND provider_message_id IS NOT NULL
          UNION
          SELECT provider_message_id FROM verification_service_messages
            WHERE verification_id IN (${storeVerifications}) AND provider_message_id IS NOT NULL
          UNION
          SELECT provider_message_id FROM customer_messages
            WHERE verification_id IN (${storeVerifications}) AND provider_message_id IS NOT NULL`)) as unknown as Array<{
          id: string;
        }>
      ).map((row) => row.id);
      // One jsonb parameter however many ids a store has.
      const idArray = sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(providerIds)}::jsonb))`;

      // Raw Meta webhooks have no org column. Finished rows that mention one
      // of this store's messages (status, inbound message, or reply context)
      // go; with organization scope, also every row for the org's own WABAs.
      // Customer phones are deliberately not matched: on the shared sender
      // they would reach other stores' rows. Waiting rows are left to the
      // Meta processor and its 30-day purge.
      const mentionsStore = sql`EXISTS (
        SELECT 1 FROM jsonb_array_elements(m.payload::jsonb->'entry') e
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e->'changes', '[]'::jsonb)) c
        WHERE EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(c->'value'->'statuses', '[]'::jsonb)) s
            WHERE s->>'id' = ANY(${idArray}))
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(c->'value'->'messages', '[]'::jsonb)) msg
            WHERE msg->>'id' = ANY(${idArray}) OR msg->'context'->>'id' = ANY(${idArray})))`;
      const ownWaba = orgScope
        ? sql`m.waba_id IN (SELECT waba_id FROM whatsapp_connections WHERE org_id = ${orgId}::uuid)`
        : sql`false`;
      const metaWebhookEvents =
        providerIds.length > 0 || orgScope
          ? await count(
              tx,
              sql`DELETE FROM meta_webhook_events m
                WHERE m.status IN ('succeeded', 'failed')
                  AND (${ownWaba} OR (m.field = 'messages' AND m.payload IS NOT NULL
                    AND ${providerIds.length > 0 ? mentionsStore : sql`false`}))
                RETURNING 1`,
            )
          : 0;

      const providerMessageReceipts =
        providerIds.length > 0
          ? await count(
              tx,
              sql`DELETE FROM provider_message_receipts
                WHERE provider_message_id = ANY(${idArray}) RETURNING 1`,
            )
          : 0;

      // Before orders and integrations: both FKs from webhook_events are NO
      // ACTION. Matched by owner OR source identity, never via order_id.
      const webhookMatch = sql`(
        (${ownedBy('w')})
        OR (w.platform = ${platform} AND w.store_domain = ${storeDomain}))`;
      if (keepId) {
        await tx.execute(sql`
          UPDATE webhook_events w SET org_id = NULL, integration_id = NULL, updated_at = now()
          WHERE w.id = ${keepId}::uuid AND w.order_id IS NULL AND ${webhookMatch}`);
      }
      const webhookEvents = await count(
        tx,
        sql`DELETE FROM webhook_events w
          WHERE ${webhookMatch}
            AND (${keepId}::uuid IS NULL OR w.id <> ${keepId}::uuid)
          RETURNING 1`,
      );

      // Cascades: verification_message_dispatches (-> sender attempts),
      // verification_service_messages, verification_reply_events,
      // verification_auto_cancellations (+ events), verification_change_requests
      // (+ events, effects) and customer_messages linked to the verification.
      const verifications = await count(
        tx,
        sql`DELETE FROM verifications WHERE id IN (${storeVerifications}) RETURNING 1`,
      );
      // Dispatches not reached through a verification (their integration FK
      // is NO ACTION).
      const messageDispatches = await count(
        tx,
        sql`DELETE FROM verification_message_dispatches d WHERE ${ownedBy('d')} RETURNING 1`,
      );
      // Cascades order_import_rows (raw spreadsheet rows); integration FK is
      // NO ACTION.
      const orderImportBatches = await count(
        tx,
        sql`DELETE FROM order_import_batches b WHERE ${ownedBy('b')} RETURNING 1`,
      );
      // Cascades commerce_outcome_syncs, and any remaining auto-cancellations
      // and change requests by their order FK.
      const orders = await count(
        tx,
        sql`DELETE FROM orders o WHERE ${ownedBy('o')} RETURNING 1`,
      );

      const counts: StoreDataDeletionCounts = {
        metaWebhookEvents,
        providerMessageReceipts,
        webhookEvents,
        verifications,
        messageDispatches,
        orderImportBatches,
        orders,
        integrationMonthlyUsage: 0,
        integrations: 0,
        memberships: 0,
        organizations: 0,
      };
      // Notice envelopes include the merchant's email and are part of store deletion.
      await tx.execute(
        sql`DELETE FROM plan_required_notices WHERE org_id=${orgId}::uuid AND integration_id=${store.integrationId}::uuid`,
      );
      if (!orgScope) return counts;

      counts.integrationMonthlyUsage = await count(
        tx,
        sql`DELETE FROM integration_monthly_usage WHERE org_id = ${orgId}::uuid RETURNING 1`,
      );
      // Cascades admin_store_lifecycles, product_events, review_prompt_*,
      // usage_alerts, integration_api_keys, woocommerce/easyorders connections.
      counts.integrations = await count(
        tx,
        sql`DELETE FROM integrations WHERE org_id = ${orgId}::uuid RETURNING 1`,
      );
      counts.memberships = await count(
        tx,
        sql`DELETE FROM memberships WHERE org_id = ${orgId}::uuid RETURNING 1`,
      );
      // Cascades customer_messages, whatsapp_connections (+ children),
      // whatsapp_connect_tickets, whatsapp_sender_alerts, tips recipients,
      // credit_model_notices, pending installs and the remaining order-import
      // tables. billing_free_plan_claims is SET NULL on purpose (0041).
      counts.organizations = await count(
        tx,
        sql`DELETE FROM organizations WHERE id = ${orgId}::uuid RETURNING 1`,
      );
      return counts;
    }
  }
}
