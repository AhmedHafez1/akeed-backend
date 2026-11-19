import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';

/**
 * The facts that decide whether a store may be deleted, as columns over an
 * `integrations` row aliased by `store`. The admin list and the delete itself
 * read the same SQL, so the button and the server never disagree.
 */
export function storeDeletionFactsSql(store: SQL): SQL {
  return sql`
    (SELECT count(*) FROM integrations org_store
      WHERE org_store.org_id = ${store}.org_id)::int AS org_store_count,
    (EXISTS (SELECT 1 FROM credit_ledger_entries ledger
        WHERE ledger.org_id = ${store}.org_id)
      OR EXISTS (SELECT 1 FROM payment_purchases purchase
        WHERE purchase.org_id = ${store}.org_id)) AS has_credit_history,
    (EXISTS (
        SELECT 1
        FROM verification_message_dispatches sent
        INNER JOIN verifications sent_v ON sent_v.id = sent.verification_id
        INNER JOIN orders sent_order ON sent_order.id = sent_v.order_id
        WHERE sent.integration_id = ${store}.id
          AND sent.accepted_at IS NOT NULL
          AND NOT sent_order.is_test)
      OR EXISTS (
        SELECT 1
        FROM orders real_order
        INNER JOIN verifications real_v ON real_v.order_id = real_order.id
        WHERE real_order.integration_id = ${store}.id
          AND NOT real_order.is_test
          AND (real_v.wa_message_id IS NOT NULL
            OR real_v.status IN ('confirmed', 'canceled')))
      OR EXISTS (
        SELECT 1
        FROM customer_messages inbound
        LEFT JOIN verifications inbound_v ON inbound_v.id = inbound.verification_id
        LEFT JOIN orders inbound_order ON inbound_order.id = inbound_v.order_id
        WHERE inbound.org_id = ${store}.org_id
          AND NOT COALESCE(inbound_order.is_test, false))) AS has_real_activity`;
}

export interface StoreDeletionFactsRow extends Record<string, unknown> {
  org_store_count: number;
  has_credit_history: boolean;
  has_real_activity: boolean;
}

export type OrganizationDeletionResult =
  | { deleted: true; userIds: string[] }
  | { deleted: false; reason: 'not_found' | 'changed' };

@Injectable()
export class AdminStoreDeletionRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  /**
   * Deletes the store's organization and everything under it in one
   * transaction. The organization row is locked first and the deletion facts
   * are read again under that lock, so an order or charge that arrived after
   * staff opened the dialog stops the delete (`changed`) instead of being
   * lost. Tables whose foreign keys do not cascade are cleared explicitly,
   * children first; the organization delete cascades the rest. Returns the
   * members' user ids so the caller can remove logins left without an
   * organization.
   */
  async deleteOrganization(params: {
    orgId: string;
    integrationId: string;
  }): Promise<OrganizationDeletionResult> {
    return this.db.transaction(async (tx) => {
      const locked = Array.from(
        await tx.execute<{ id: string }>(sql`
          SELECT id FROM organizations WHERE id = ${params.orgId} FOR UPDATE
        `),
      );
      if (locked.length === 0) return { deleted: false, reason: 'not_found' };

      const [facts] = Array.from(
        await tx.execute<StoreDeletionFactsRow & { id: string }>(sql`
          SELECT store.id, ${storeDeletionFactsSql(sql`store`)}
          FROM integrations store
          WHERE store.id = ${params.integrationId}
            AND store.org_id = ${params.orgId}
        `),
      );
      if (
        !facts ||
        Number(facts.org_store_count) !== 1 ||
        facts.has_credit_history ||
        facts.has_real_activity
      )
        return { deleted: false, reason: 'changed' };

      const userIds = Array.from(
        await tx.execute<{ user_id: string }>(sql`
          SELECT user_id FROM memberships WHERE org_id = ${params.orgId}
        `),
      ).map((row) => row.user_id);

      const org = params.orgId;
      const storeOrders = sql`SELECT id FROM orders WHERE org_id = ${org} OR integration_id = ${params.integrationId}`;
      const storeVerifications = sql`SELECT id FROM verifications WHERE order_id IN (${storeOrders})`;
      const storeDispatches = sql`SELECT id FROM verification_message_dispatches WHERE org_id = ${org} OR integration_id = ${params.integrationId}`;
      for (const statement of [
        sql`DELETE FROM webhook_events WHERE org_id = ${org} OR integration_id = ${params.integrationId} OR order_id IN (${storeOrders})`,
        sql`DELETE FROM verification_service_messages WHERE dispatch_id IN (${storeDispatches})`,
        sql`DELETE FROM credit_reservations WHERE org_id = ${org}`,
        sql`DELETE FROM customer_messages WHERE org_id = ${org}`,
        sql`DELETE FROM verification_sender_attempts WHERE org_id = ${org}`,
        sql`DELETE FROM verification_change_request_events WHERE org_id = ${org} OR verification_id IN (${storeVerifications})`,
        sql`DELETE FROM verification_message_dispatches WHERE id IN (${storeDispatches})`,
        sql`DELETE FROM verifications WHERE org_id = ${org} OR id IN (${storeVerifications})`,
        sql`DELETE FROM orders WHERE id IN (${storeOrders})`,
        sql`DELETE FROM order_import_batches WHERE integration_id = ${params.integrationId}`,
        sql`DELETE FROM integration_monthly_usage WHERE integration_id = ${params.integrationId}`,
        sql`DELETE FROM payment_provider_events WHERE org_id = ${org}`,
        sql`DELETE FROM billing_reconciliation_findings WHERE org_id = ${org}`,
        sql`DELETE FROM billing_reconciliation_attempts WHERE org_id = ${org}`,
        sql`DELETE FROM credit_accounts WHERE org_id = ${org}`,
        sql`DELETE FROM memberships WHERE org_id = ${org}`,
        sql`DELETE FROM integrations WHERE org_id = ${org}`,
        sql`DELETE FROM organizations WHERE id = ${org}`,
      ])
        await tx.execute(statement);

      return { deleted: true, userIds };
    });
  }

  /** Of these users, the ones no longer a member of any organization. */
  async findUsersWithoutOrganization(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db.execute<{ id: string }>(sql`
      SELECT candidate.id
      FROM (VALUES ${sql.join(
        userIds.map((id) => sql`(${id}::uuid)`),
        sql`, `,
      )}) AS candidate(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM memberships member WHERE member.user_id = candidate.id
      )
    `);
    return Array.from(rows).map((row) => row.id);
  }
}
