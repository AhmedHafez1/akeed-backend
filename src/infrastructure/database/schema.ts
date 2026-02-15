import {
  pgTable,
  unique,
  pgPolicy,
  check,
  uuid,
  text,
  varchar,
  timestamp,
  index,
  foreignKey,
  boolean,
  jsonb,
  numeric,
  integer,
  pgEnum,
  pgSchema,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const verificationStatus = pgEnum('verification_status', [
  'pending',
  'sent',
  'delivered',
  'read',
  'confirmed',
  'canceled',
  'expired',
  'failed',
]);

export const integrationDefaultLanguage = pgEnum(
  'integration_default_language',
  ['en', 'ar', 'auto'],
);

export const integrationOnboardingStatus = pgEnum(
  'integration_onboarding_status',
  ['pending', 'completed'],
);

export const integrationBillingPlanId = pgEnum('integration_billing_plan_id', [
  'starter',
  'growth',
  'pro',
  'scale',
]);

// Reference to Supabase auth.users table (managed by Supabase Auth)
export const authSchema = pgSchema('auth');
export const users = authSchema.table('users', {
  id: uuid('id').primaryKey(),
});

export const organizations = pgTable(
  'organizations',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    planType: text('plan_type').default('free'),
    waPhoneNumberId: text('wa_phone_number_id'),
    waBusinessAccountId: text('wa_business_account_id'),
    waAccessToken: text('wa_access_token'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
  },
  (table) => [
    unique('organizations_slug_key').on(table.slug),
    pgPolicy('Owners update organizations', {
      as: 'permissive',
      for: 'update',
      to: ['authenticated'],
      using: sql`(id IN ( SELECT memberships.org_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.role = 'owner'::text))))`,
      withCheck: sql`(id IN ( SELECT memberships.org_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.role = 'owner'::text))))`,
    }),
    pgPolicy('Users see their organizations', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
    }),
    check(
      'organizations_plan_type_check',
      sql`plan_type = ANY (ARRAY['free'::text, 'pro'::text, 'enterprise'::text])`,
    ),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text().default('owner'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
  },
  (table) => [
    index('idx_memberships_org_id').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_memberships_user_id').using(
      'btree',
      table.userId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'memberships_org_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'memberships_user_id_fkey',
    }).onDelete('cascade'),
    unique('memberships_org_id_user_id_key').on(table.orgId, table.userId),
    pgPolicy('Owners manage memberships', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: sql`(org_id IN ( SELECT memberships_1.org_id
   FROM memberships memberships_1
  WHERE ((memberships_1.user_id = auth.uid()) AND (memberships_1.role = 'owner'::text))))`,
      withCheck: sql`(org_id IN ( SELECT memberships_1.org_id
   FROM memberships memberships_1
  WHERE ((memberships_1.user_id = auth.uid()) AND (memberships_1.role = 'owner'::text))))`,
    }),
    pgPolicy('Users see own memberships', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
    }),
    check(
      'memberships_role_check',
      sql`role = ANY (ARRAY['owner'::text, 'admin'::text, 'viewer'::text])`,
    ),
  ],
);

export const integrations = pgTable(
  'integrations',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    orgId: uuid('org_id').notNull(),
    platformType: text('platform_type').notNull(),
    platformStoreUrl: text('platform_store_url').notNull(),
    accessToken: text('access_token'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    webhookSecret: text('webhook_secret'),
    isActive: boolean('is_active').default(true),
    lastSyncedAt: timestamp('last_synced_at', {
      withTimezone: true,
      mode: 'string',
    }),
    metadata: jsonb().default({}),
    storeName: varchar('store_name', { length: 255 }),
    defaultLanguage: integrationDefaultLanguage('default_language')
      .default('auto')
      .notNull(),
    isAutoVerifyEnabled: boolean('is_auto_verify_enabled')
      .default(true)
      .notNull(),
    onboardingStatus: integrationOnboardingStatus('onboarding_status')
      .default('pending')
      .notNull(),
    billingPlanId: integrationBillingPlanId('billing_plan_id'),
    shopifySubscriptionId: text('shopify_subscription_id'),
    billingStatus: text('billing_status'),
    billingInitiatedAt: timestamp('billing_initiated_at', {
      withTimezone: true,
      mode: 'string',
    }),
    billingActivatedAt: timestamp('billing_activated_at', {
      withTimezone: true,
      mode: 'string',
    }),
    billingCanceledAt: timestamp('billing_canceled_at', {
      withTimezone: true,
      mode: 'string',
    }),
    billingStatusUpdatedAt: timestamp('billing_status_updated_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
  },
  (table) => [
    index('idx_integrations_org_id').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_integrations_platform').using(
      'btree',
      table.platformType.asc().nullsLast().op('bool_ops'),
      table.isActive.asc().nullsLast().op('bool_ops'),
    ),
    index('idx_integrations_billing_status').using(
      'btree',
      table.billingStatus.asc().nullsLast().op('text_ops'),
    ),
    index('idx_integrations_shopify_subscription_id').using(
      'btree',
      table.shopifySubscriptionId.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'integrations_org_id_fkey',
    }).onDelete('cascade'),
    unique('integrations_platform_type_platform_store_url_key').on(
      table.platformType,
      table.platformStoreUrl,
    ),
    pgPolicy('Multi-tenant integrations', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: sql`(org_id = get_user_org_id())`,
      withCheck: sql`(org_id = get_user_org_id())`,
    }),
    check(
      'integrations_platform_type_check',
      sql`platform_type = ANY (ARRAY['shopify'::text, 'salla'::text, 'zid'::text, 'woocommerce'::text])`,
    ),
  ],
);

export const shopifyWebhookEvents = pgTable(
  'shopify_webhook_events',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    orgId: uuid('org_id'),
    integrationId: uuid('integration_id'),
    webhookId: text('webhook_id').notNull(),
    topic: text('topic'),
    shopDomain: text('shop_domain'),
    receivedAt: timestamp('received_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
  },
  (table) => [
    index('idx_shopify_webhook_events_org_id').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_shopify_webhook_events_integration_id').using(
      'btree',
      table.integrationId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'shopify_webhook_events_org_id_fkey',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.integrationId],
      foreignColumns: [integrations.id],
      name: 'shopify_webhook_events_integration_id_fkey',
    }).onDelete('set null'),
    unique('shopify_webhook_events_webhook_id_key').on(table.webhookId),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    orgId: uuid('org_id').notNull(),
    integrationId: uuid('integration_id'),
    externalOrderId: text('external_order_id').notNull(),
    orderNumber: text('order_number'),
    customerPhone: text('customer_phone').notNull(),
    customerName: text('customer_name'),
    customerEmail: text('customer_email'),
    totalPrice: numeric('total_price', { precision: 12, scale: 2 }),
    currency: text().default('SAR'),
    paymentMethod: text('payment_method'),
    rawPayload: jsonb('raw_payload'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
  },
  (table) => [
    index('idx_orders_created_at').using(
      'btree',
      table.createdAt.desc().nullsFirst().op('timestamptz_ops'),
    ),
    index('idx_orders_external_id').using(
      'btree',
      table.externalOrderId.asc().nullsLast().op('text_ops'),
    ),
    index('idx_orders_org_id').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_orders_phone').using(
      'btree',
      table.customerPhone.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.integrationId],
      foreignColumns: [integrations.id],
      name: 'orders_integration_id_fkey',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'orders_org_id_fkey',
    }).onDelete('cascade'),
    unique('unique_external_order_per_integration').on(
      table.integrationId,
      table.externalOrderId,
    ),
    pgPolicy('Service role inserts orders', {
      as: 'permissive',
      for: 'insert',
      to: ['service_role'],
      withCheck: sql`true`,
    }),
    pgPolicy('Multi-tenant orders', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
    }),
  ],
);

export const verifications = pgTable(
  'verifications',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    orgId: uuid('org_id').notNull(),
    orderId: uuid('order_id').notNull(),
    status: verificationStatus().default('pending'),
    waMessageId: text('wa_message_id'),
    templateName: text('template_name').default('cod_verification'),
    languageCode: text('language_code').default('ar'),
    attempts: integer().default(0),
    lastSentAt: timestamp('last_sent_at', {
      withTimezone: true,
      mode: 'string',
    }),
    nextRetryAt: timestamp('next_retry_at', {
      withTimezone: true,
      mode: 'string',
    }),
    confirmedAt: timestamp('confirmed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    canceledAt: timestamp('canceled_at', {
      withTimezone: true,
      mode: 'string',
    }),
    expiredAt: timestamp('expired_at', { withTimezone: true, mode: 'string' }),
    metadata: jsonb().default({}),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
  },
  (table) => [
    index('idx_verifications_next_retry')
      .using('btree', table.nextRetryAt.asc().nullsLast().op('timestamptz_ops'))
      .where(
        sql`(status = ANY (ARRAY['pending'::verification_status, 'sent'::verification_status]))`,
      ),
    index('idx_verifications_org_id').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_verifications_status').using(
      'btree',
      table.status.asc().nullsLast().op('enum_ops'),
    ),
    index('idx_verifications_wa_id').using(
      'btree',
      table.waMessageId.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [orders.id],
      name: 'verifications_order_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'verifications_org_id_fkey',
    }).onDelete('cascade'),
    unique('unique_active_verification_per_order').on(table.orderId),
    pgPolicy('Service role updates verifications', {
      as: 'permissive',
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy('Multi-tenant verifications', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
    }),
  ],
);
