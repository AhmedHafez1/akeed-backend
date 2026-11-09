import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { desc, eq, and, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE } from '../database.provider';
import {
  integrations,
  orderImportRows,
  orders,
  verificationMessageDispatches,
  verifications,
  webhookEvents,
  customerMessages,
  metaWebhookEvents,
} from '../schema';
import {
  BLOCKED_EVENT_REASONS as blockedEventReasons,
  RETRYABLE_VERIFICATION_REASONS as retryableVerificationReasons,
} from '../../../shared/verification/verification-lifecycle';
import { phoneRegion } from '../../../shared/services/phone.service';
import type { CurrentOrderDetails } from '../../../shared/ports/current-order-source.port';

const dispatchCount = sql<number>`(
  SELECT count(*)::int
  FROM ${verificationMessageDispatches}
  WHERE ${verificationMessageDispatches.verificationId} = ${verifications.id}
)`;

const hasUnknownDispatch = sql<boolean>`EXISTS (
  SELECT 1
  FROM ${verificationMessageDispatches}
  WHERE ${verificationMessageDispatches.verificationId} = ${verifications.id}
    AND ${verificationMessageDispatches.state} = 'outcome_unknown'
)`;

const verificationReason = sql<
  string | null
>`${verifications.metadata}->>'reason'`;

const retryGuardStatus = sql<string>`CASE
  WHEN ${verifications.id} IS NOT NULL THEN CASE
    -- A customer reply is the final word. It outranks an unresolved dispatch
    -- so a confirmed order never surfaces as 'review_required'.
    WHEN ${verifications.status} IN ('confirmed', 'canceled')
      THEN ${verifications.status}::text
    WHEN ${hasUnknownDispatch}
      OR (${dispatchCount} = 0 AND ${verificationReason} = 'provider_outcome_unknown')
      THEN 'review_required'
    WHEN ${verifications.status} IN ('failed', 'blocked')
      AND ${verificationReason} IN (${sql.join(
        retryableVerificationReasons.map((reason) => sql`${reason}`),
        sql`, `,
      )})
      THEN 'blocked'
    ELSE COALESCE(${verifications.status}::text, 'pending')
  END
  -- A held event is a pending row that must not read as 'accepted': nothing is
  -- about to be sent until the merchant starts it. 'released' falls through to
  -- the ordinary lifecycle below.
  WHEN ${webhookEvents.holdState} = 'held' THEN 'awaiting_start'
  WHEN ${webhookEvents.holdState} = 'withdrawn' THEN 'not_started'
  WHEN ${webhookEvents.id} IS NULL OR ${webhookEvents.status} = 'pending'
    THEN 'accepted'
  WHEN ${webhookEvents.status} = 'processing' THEN 'processing'
  WHEN ${webhookEvents.lastError} IN ('non_cod_payment_method', 'missing_payment_signal')
    THEN 'ineligible'
  WHEN ${webhookEvents.lastError} IN (${sql.join(
    blockedEventReasons.map((reason) => sql`${reason}`),
    sql`, `,
  )})
    THEN 'blocked'
  ELSE 'failed'
END`;

const retryGuardReason = sql<string | null>`CASE
  WHEN ${verifications.id} IS NOT NULL THEN CASE
    -- A resolved verification has no outstanding reason to report.
    WHEN ${verifications.status} IN ('confirmed', 'canceled') THEN NULL
    WHEN ${hasUnknownDispatch}
      OR (${dispatchCount} = 0 AND ${verificationReason} = 'provider_outcome_unknown')
      THEN 'provider_outcome_unknown'
    WHEN ${dispatchCount} > 0 AND ${verificationReason} = 'provider_outcome_unknown'
      THEN NULL
    ELSE ${verificationReason}
  END
  WHEN ${webhookEvents.holdState} = 'held' THEN NULL
  ELSE ${webhookEvents.lastError}
END`;

const retryGuardRetryable = sql<boolean>`CASE
  WHEN ${verifications.id} IS NOT NULL THEN
    ${verifications.status} IN ('failed', 'blocked')
    AND NOT ${hasUnknownDispatch}
    AND ${verificationReason} IN (${sql.join(
      retryableVerificationReasons.map((reason) => sql`${reason}`),
      sql`, `,
    )})
  WHEN ${webhookEvents.holdState} IN ('held', 'withdrawn') THEN false
  WHEN ${webhookEvents.id} IS NULL OR ${webhookEvents.status} IN ('pending', 'processing')
    THEN false
  WHEN ${webhookEvents.lastError} IN (${sql.join(
    blockedEventReasons.map((reason) => sql`${reason}`),
    sql`, `,
  )}) THEN true
  ELSE COALESCE(${webhookEvents.lastError} LIKE 'dispatch_terminal:%', false)
END`;

/**
 * Everything a Shopify GDPR request can name a customer by. Any one key is
 * enough to match; empty keys are left out of the match.
 */
export interface ShopifyCustomerKeys {
  customerId?: string;
  email?: string;
  phones: string[];
  externalOrderIds: string[];
}

export interface ShopifyCustomerRedactionResult {
  orders: number;
  verifications: number;
  webhookEvents: number;
}

/** Stored webhook rows that carry a Shopify order JSON. */
const SHOPIFY_ORDER_JOB_TYPES = ['order.create', 'order.update'];

export function hasShopifyCustomerKeys(keys: ShopifyCustomerKeys): boolean {
  return Boolean(
    keys.customerId ||
    keys.email ||
    keys.phones.length > 0 ||
    keys.externalOrderIds.length > 0,
  );
}

function shopifyCustomerOrderMatch(keys: ShopifyCustomerKeys): SQL | undefined {
  const clauses: SQL[] = [];
  if (keys.externalOrderIds.length > 0) {
    clauses.push(inArray(orders.externalOrderId, keys.externalOrderIds));
  }
  if (keys.customerId) {
    clauses.push(
      sql`${orders.rawPayload}->'customer'->>'id' = ${keys.customerId}`,
    );
  }
  if (keys.email) {
    clauses.push(sql`lower(${orders.customerEmail}) = lower(${keys.email})`);
  }
  if (keys.phones.length > 0) {
    clauses.push(inArray(orders.customerPhone, keys.phones));
  }
  return clauses.length > 0 ? or(...clauses) : undefined;
}

/**
 * The order payload is stored as Shopify sent it, so the match reads the raw
 * fields; rows already linked to a matched order are caught by `order_id`.
 * This also reaches orders Akeed skipped and never stored as an order.
 */
function shopifyCustomerWebhookMatch(
  keys: ShopifyCustomerKeys,
  orderIds: string[],
): SQL | undefined {
  const payload = webhookEvents.rawPayload;
  const clauses: SQL[] = [];
  if (orderIds.length > 0) {
    clauses.push(inArray(webhookEvents.orderId, orderIds));
  }
  if (keys.externalOrderIds.length > 0) {
    clauses.push(inArray(sql`${payload}->>'id'`, keys.externalOrderIds));
  }
  if (keys.customerId) {
    clauses.push(sql`${payload}->'customer'->>'id' = ${keys.customerId}`);
  }
  if (keys.email) {
    clauses.push(
      sql`lower(${payload}->>'email') = lower(${keys.email})`,
      sql`lower(${payload}->'customer'->>'email') = lower(${keys.email})`,
    );
  }
  if (keys.phones.length > 0) {
    clauses.push(
      inArray(sql`${payload}->>'phone'`, keys.phones),
      inArray(sql`${payload}->'customer'->>'phone'`, keys.phones),
      inArray(sql`${payload}->'shipping_address'->>'phone'`, keys.phones),
      inArray(sql`${payload}->'billing_address'->>'phone'`, keys.phones),
    );
  }
  return clauses.length > 0 ? or(...clauses) : undefined;
}

@Injectable()
export class OrdersRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async create(data: typeof orders.$inferInsert) {
    const [result] = await this.db
      .insert(orders)
      .values({
        ...data,
        customerCountry:
          data.customerCountry ?? phoneRegion(data.customerPhone),
      })
      .returning();
    return result;
  }

  /**
   * Restates an order's message details as its source holds them now, before
   * an updated confirmation is built from them. Only the details a message
   * shows change; the order's identity, number and captured payload stay.
   * Scoped by tenant: an order of another organization is not touched.
   */
  async refreshCurrentDetails(
    orderId: string,
    orgId: string,
    details: CurrentOrderDetails,
  ) {
    const [row] = await this.db
      .update(orders)
      .set({
        customerPhone: details.customerPhone,
        customerCountry: phoneRegion(details.customerPhone),
        customerName: details.customerName ?? null,
        totalPrice: details.totalPrice,
        currency: details.currency,
        ...(details.paymentMethod
          ? { paymentMethod: details.paymentMethod }
          : {}),
        lineItems: details.lineItems?.length ? details.lineItems : null,
        shippingRegion: details.shippingRegion ?? null,
        shippingAddress: details.shippingAddress ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.orgId, orgId)))
      .returning({ id: orders.id });
    return row ?? null;
  }

  /**
   * Whether the organization has any real (non-test) order yet. Onboarding
   * test orders carry is_test = true and never count. Drives the standalone
   * dashboard's first-run state; LIMIT 1 stops at the first real row.
   */
  async hasRealOrders(orgId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.orgId, orgId), eq(orders.isTest, false)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The currency of the integration's most recent real order, or null when it
   * has none. Messages write each order's own currency, so this is the one a
   * message preview should show.
   */
  async findLatestOrderCurrency(
    orgId: string,
    integrationId: string,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ currency: orders.currency })
      .from(orders)
      .where(
        and(
          eq(orders.orgId, orgId),
          eq(orders.integrationId, integrationId),
          eq(orders.isTest, false),
          sql`${orders.currency} IS NOT NULL`,
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(1);
    return row?.currency ?? null;
  }

  async findById(orderId: string) {
    return await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      with: {
        integration: true,
        verifications: { with: { messageDispatches: true } },
        webhookEvents: true,
      },
    });
  }

  async findBySourceExternalId(source: {
    orgId: string;
    integrationId: string;
    externalOrderId: string;
  }) {
    return await this.db.query.orders.findFirst({
      where: and(
        eq(orders.orgId, source.orgId),
        eq(orders.integrationId, source.integrationId),
        eq(orders.externalOrderId, source.externalOrderId),
      ),
    });
  }

  async findForOutcomeDispatch(source: {
    orgId: string;
    integrationId: string;
    externalOrderId: string;
  }) {
    return await this.db.query.orders.findFirst({
      where: and(
        eq(orders.orgId, source.orgId),
        eq(orders.integrationId, source.integrationId),
        eq(orders.externalOrderId, source.externalOrderId),
      ),
      with: {
        integration: true,
      },
    });
  }

  async findByOrg(
    orgId: string,
    opts?: { cursor?: { createdAt: string; id: string }; limit?: number },
  ): Promise<
    Array<
      typeof orders.$inferSelect & {
        verifications: Array<
          typeof schema.verifications.$inferSelect & {
            messageDispatches: Array<
              typeof schema.verificationMessageDispatches.$inferSelect
            >;
          }
        >;
        webhookEvents: Array<typeof schema.webhookEvents.$inferSelect>;
      }
    >
  > {
    const limit = opts?.limit ?? 50;

    const conditions = [eq(orders.orgId, orgId)];

    if (opts?.cursor) {
      conditions.push(
        or(
          lt(orders.createdAt, opts.cursor.createdAt),
          and(
            sql`${orders.createdAt} = ${opts.cursor.createdAt}`,
            lt(orders.id, opts.cursor.id),
          ),
        )!,
      );
    }

    return await this.db.query.orders.findMany({
      where: and(...conditions),
      with: {
        verifications: { with: { messageDispatches: true } },
        webhookEvents: true,
      },
      orderBy: (orders, { desc }) => [desc(orders.createdAt), desc(orders.id)],
      limit,
    });
  }

  /**
   * Load a single order together with the state the retry endpoint guards on.
   *
   * These states (`accepted`, `processing`, `review_required`, `blocked`,
   * `ineligible`, and the hold states `awaiting_start` / `not_started`) are
   * deliberately *not* part of the merchant-facing status
   * vocabulary — the dashboard speaks only the nine values the
   * `verification_status` enum can hold. They exist here because retry safety
   * needs finer distinctions than the UI does: an order whose dispatch outcome
   * is unknown must not be re-sent, and one still queued must not be treated as
   * a failure. Computed in SQL so the guard cannot drift from the data.
   */
  async findDashboardOrderById(orderId: string, orgId: string) {
    const [row] = await this.db
      .select({
        id: orders.id,
        orgId: orders.orgId,
        integrationId: orders.integrationId,
        externalOrderId: orders.externalOrderId,
        isTest: orders.isTest,
        platformType: integrations.platformType,
        verificationId: verifications.id,
        verificationStatus: verifications.status,
        retryGuardStatus,
        retryGuardReason,
        retryGuardRetryable,
      })
      .from(orders)
      .innerJoin(integrations, eq(integrations.id, orders.integrationId))
      .leftJoin(verifications, eq(verifications.orderId, orders.id))
      .leftJoin(webhookEvents, eq(webhookEvents.orderId, orders.id))
      .where(and(eq(orders.id, orderId), eq(orders.orgId, orgId)))
      .limit(1);
    return row;
  }

  /**
   * How many of an import batch's orders sit in each dashboard lifecycle
   * status, in one grouped query over the same projection the verifications
   * table renders, so the batch page and the table never disagree.
   */
  async countLifecycleByImportBatch(
    orgId: string,
    batchId: string,
  ): Promise<Array<{ status: string; count: number }>> {
    const rows = await this.db
      .select({
        status: retryGuardStatus,
        count: sql<number>`count(DISTINCT ${orders.id})::int`,
      })
      .from(orders)
      .innerJoin(
        orderImportRows,
        and(
          eq(orderImportRows.orderId, orders.id),
          eq(orderImportRows.batchId, batchId),
          eq(orderImportRows.orgId, orgId),
        ),
      )
      .leftJoin(verifications, eq(verifications.orderId, orders.id))
      .leftJoin(webhookEvents, eq(webhookEvents.orderId, orders.id))
      .where(eq(orders.orgId, orgId))
      // By position: the projection carries bound parameters, and PostgreSQL
      // will not match a GROUP BY copy of it whose placeholders are numbered
      // anew ("must appear in the GROUP BY clause").
      .groupBy(sql`1`);
    return rows.map((row) => ({
      status: row.status,
      count: Number(row.count),
    }));
  }

  async findShopifyCustomerOrders(
    orgId: string,
    integrationId: string,
    keys: ShopifyCustomerKeys,
  ): Promise<
    Array<
      typeof orders.$inferSelect & {
        verifications: Array<typeof schema.verifications.$inferSelect>;
      }
    >
  > {
    const match = shopifyCustomerOrderMatch(keys);
    if (!match) {
      return [];
    }

    const customerOrders = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.orgId, orgId),
          eq(orders.integrationId, integrationId),
          match,
        ),
      )
      .orderBy(desc(orders.createdAt));
    if (customerOrders.length === 0) {
      return [];
    }

    const orderVerifications = await this.db
      .select()
      .from(verifications)
      .where(
        and(
          eq(verifications.orgId, orgId),
          inArray(
            verifications.orderId,
            customerOrders.map((order) => order.id),
          ),
        ),
      );
    return customerOrders.map((order) => ({
      ...order,
      verifications: orderVerifications.filter(
        (verification) => verification.orderId === order.id,
      ),
    }));
  }

  /**
   * Anonymises one Shopify customer's orders, clears their verification
   * metadata and empties the stored order webhook payloads that name them, in
   * one transaction. Orders stay (anonymised) so usage and billing history
   * hold. Re-running matches nothing new, since the matched fields are gone.
   * `dryRun` counts the same rows without writing.
   */
  async redactShopifyCustomer(
    orgId: string,
    integrationId: string,
    keys: ShopifyCustomerKeys,
    options: { dryRun?: boolean } = {},
  ): Promise<ShopifyCustomerRedactionResult> {
    const orderMatch = shopifyCustomerOrderMatch(keys);
    if (!orderMatch) {
      return { orders: 0, verifications: 0, webhookEvents: 0 };
    }

    return this.db.transaction(async (tx) => {
      const matchedOrders = await tx
        .select({ id: orders.id, customerPhone: orders.customerPhone })
        .from(orders)
        .where(
          and(
            eq(orders.orgId, orgId),
            eq(orders.integrationId, integrationId),
            orderMatch,
          ),
        )
        .for('update');
      const orderIds = matchedOrders.map((order) => order.id);

      const webhookWhere = and(
        eq(webhookEvents.platform, 'shopify'),
        eq(webhookEvents.orgId, orgId),
        eq(webhookEvents.integrationId, integrationId),
        inArray(webhookEvents.jobType, SHOPIFY_ORDER_JOB_TYPES),
        sql`${webhookEvents.rawPayload} <> '{}'::jsonb`,
        shopifyCustomerWebhookMatch(keys, orderIds),
      );
      const verificationWhere =
        orderIds.length > 0
          ? and(
              eq(verifications.orgId, orgId),
              inArray(verifications.orderId, orderIds),
            )
          : undefined;

      if (options.dryRun) {
        const [webhookCount] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(webhookEvents)
          .where(webhookWhere);
        const [verificationCount] = verificationWhere
          ? await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(verifications)
              .where(verificationWhere)
          : [{ count: 0 }];
        return {
          orders: orderIds.length,
          verifications: Number(verificationCount.count),
          webhookEvents: Number(webhookCount.count),
        };
      }

      const now = new Date().toISOString();
      const phones = [
        ...new Set(
          [...keys.phones, ...matchedOrders.map((order) => order.customerPhone)]
            .map((phone) => phone.replace(/[^0-9]/g, ''))
            .filter(Boolean),
        ),
      ];
      const customerMessageMatch = and(
        eq(customerMessages.orgId, orgId),
        or(
          phones.length
            ? inArray(customerMessages.customerPhone, phones)
            : undefined,
          orderIds.length
            ? sql`${customerMessages.verificationId} IN (SELECT v.id FROM verifications v WHERE v.org_id = ${orgId} AND v.order_id IN (${sql.join(
                orderIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )}))`
            : undefined,
        ) ?? sql`false`,
      );
      // Keep only provider identities to refuse a replay of the erased content.
      const erasedMessages = await tx
        .update(customerMessages)
        .set({
          body: null,
          customerPhone: null,
          customerUserId: null,
          redactedAt: now,
        })
        .where(customerMessageMatch)
        .returning({ providerMessageId: customerMessages.providerMessageId });
      const erasedIds = erasedMessages.map(
        (message) => message.providerMessageId,
      );
      const phoneArray = sql`ARRAY[${sql.join(
        phones.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`;
      const messageArray = sql`ARRAY[${sql.join(
        erasedIds.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`;
      if (phones.length || erasedIds.length) {
        const retainedEvents = await tx
          .select({
            id: metaWebhookEvents.id,
            payload: metaWebhookEvents.payload,
          })
          .from(metaWebhookEvents)
          .where(
            and(
              eq(metaWebhookEvents.field, 'messages'),
              sql`${metaWebhookEvents.payload} IS NOT NULL`,
              sql`EXISTS (SELECT 1 FROM jsonb_array_elements((${metaWebhookEvents.payload}::jsonb)->'entry') e
            CROSS JOIN LATERAL jsonb_array_elements(e->'changes') c
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c->'value'->'messages', '[]'::jsonb)) m
            WHERE (m->>'id' = ANY(${messageArray}) OR regexp_replace(m->>'from', '[^0-9]', '', 'g') = ANY(${phoneArray}))
              AND (e->>'id' IN (SELECT wc.waba_id FROM whatsapp_connections wc WHERE wc.org_id = ${orgId})
                   OR m->>'id' = ANY(${messageArray})))`,
            ),
          )
          .for('update');
        const ownedWabas = new Set(
          (
            await tx
              .select({ wabaId: schema.whatsappConnections.wabaId })
              .from(schema.whatsappConnections)
              .where(eq(schema.whatsappConnections.orgId, orgId))
          ).map((row) => row.wabaId),
        );
        for (const event of retainedEvents) {
          const payload = JSON.parse(event.payload!) as {
            entry: {
              id: string;
              changes: {
                value?: { messages?: { id?: string; from?: string }[] };
              }[];
            }[];
          };
          for (const entry of payload.entry)
            for (const change of entry.changes) {
              if (change.value?.messages)
                change.value.messages = change.value.messages.filter(
                  (message) =>
                    !erasedIds.includes(message.id ?? '') &&
                    !(
                      ownedWabas.has(entry.id) &&
                      phones.includes(
                        (message.from ?? '').replace(/[^0-9]/g, ''),
                      )
                    ),
                );
            }
          await tx
            .update(metaWebhookEvents)
            .set({ payload: JSON.stringify(payload) })
            .where(eq(metaWebhookEvents.id, event.id));
        }
      }
      if (orderIds.length > 0) {
        await tx
          .update(orders)
          .set({
            customerPhone: '',
            customerCountry: null,
            customerName: null,
            customerEmail: null,
            rawPayload: {},
            lineItems: null,
            shippingRegion: null,
            shippingAddress: null,
            updatedAt: now,
          })
          .where(inArray(orders.id, orderIds));
      }
      const clearedVerifications = verificationWhere
        ? await tx
            .update(verifications)
            .set({ metadata: {}, updatedAt: now })
            .where(verificationWhere)
            .returning({ id: verifications.id })
        : [];
      const scrubbedWebhookEvents = await tx
        .update(webhookEvents)
        .set({ rawPayload: {}, updatedAt: now })
        .where(webhookWhere)
        .returning({ id: webhookEvents.id });

      return {
        orders: orderIds.length,
        verifications: clearedVerifications.length,
        webhookEvents: scrubbedWebhookEvents.length,
      };
    });
  }

  /**
   * Removes one store's orders and everything hanging off them, leaving the
   * org and integration rows (and their lifecycle history) for audit. Order-
   * linked webhook events go first because their FK to orders has no action;
   * message dispatches follow their verifications by cascade.
   */
  async purgeByIntegration(
    orgId: string,
    integrationId: string,
  ): Promise<{ orders: number; verifications: number; webhookEvents: number }> {
    return this.db.transaction(async (tx) => {
      const integrationOrderIds = tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(eq(orders.orgId, orgId), eq(orders.integrationId, integrationId)),
        );

      const deletedWebhookEvents = await tx
        .delete(webhookEvents)
        .where(
          and(
            eq(webhookEvents.orgId, orgId),
            inArray(webhookEvents.orderId, integrationOrderIds),
          ),
        )
        .returning({ id: webhookEvents.id });

      const deletedVerifications = await tx
        .delete(verifications)
        .where(
          and(
            eq(verifications.orgId, orgId),
            inArray(verifications.orderId, integrationOrderIds),
          ),
        )
        .returning({ id: verifications.id });

      const deletedOrders = await tx
        .delete(orders)
        .where(
          and(eq(orders.orgId, orgId), eq(orders.integrationId, integrationId)),
        )
        .returning({ id: orders.id });

      return {
        orders: deletedOrders.length,
        verifications: deletedVerifications.length,
        webhookEvents: deletedWebhookEvents.length,
      };
    });
  }

  async deleteByOrgId(orgId: string): Promise<number> {
    const results = await this.db
      .delete(orders)
      .where(eq(orders.orgId, orgId))
      .returning({ id: orders.id });

    return results.length;
  }
}
