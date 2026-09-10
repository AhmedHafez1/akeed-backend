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
  date,
  pgEnum,
  pgSchema,
  uniqueIndex,
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
  'no_reply',
]);

export const verificationDispatchKind = pgEnum('verification_dispatch_kind', [
  'initial',
  'follow_up',
  'legacy_unknown',
]);

export const verificationDispatchState = pgEnum('verification_dispatch_state', [
  'ready',
  'sending',
  'accepted',
  'rejected',
  'outcome_unknown',
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
  'basic',
  'pro',
  'business',
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
      using: sql`(id = get_user_org_id())`,
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
      using: sql`(user_id = auth.uid())`,
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
    codTemplateArVariant: text('cod_template_ar_variant')
      .default('standard')
      .notNull(),
    codTemplateEnVariant: text('cod_template_en_variant')
      .default('friendly')
      .notNull(),
    shippingCurrency: text('shipping_currency').default('USD').notNull(),
    avgShippingCost: numeric('avg_shipping_cost', { precision: 10, scale: 2 })
      .default('3')
      .notNull(),
    isAutoVerifyEnabled: boolean('is_auto_verify_enabled')
      .default(true)
      .notNull(),
    assumeCodWhenPaymentMissing: boolean('assume_cod_when_payment_missing')
      .default(false)
      .notNull(),
    onboardingStatus: integrationOnboardingStatus('onboarding_status')
      .default('pending')
      .notNull(),
    billingPlanId: integrationBillingPlanId('billing_plan_id'),
    pendingBillingPlanId: integrationBillingPlanId('pending_billing_plan_id'),
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
    followUpEnabled: boolean('follow_up_enabled').default(true).notNull(),
    followUpDelayMinutes: integer('follow_up_delay_minutes')
      .default(120)
      .notNull(),
    escalationEnabled: boolean('escalation_enabled').default(true).notNull(),
    escalationDelayMinutes: integer('escalation_delay_minutes')
      .default(360)
      .notNull(),
    quietHoursEnabled: boolean('quiet_hours_enabled').default(false).notNull(),
    quietHoursStart: text('quiet_hours_start'),
    quietHoursEnd: text('quiet_hours_end'),
    timezone: text('timezone').default('Asia/Riyadh').notNull(),
    sendDelayMinutes: integer('send_delay_minutes').default(0).notNull(),
    countryCode: varchar('country_code', { length: 2 }),
    shopTimezone: text('shop_timezone'),
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
    uniqueIndex('integrations_one_active_source_per_org_idx')
      .on(table.orgId)
      .where(sql`${table.isActive} = true`),
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
    unique('integrations_id_org_id_key').on(table.id, table.orgId),
    pgPolicy('Multi-tenant integrations', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: sql`(org_id = get_user_org_id())`,
      withCheck: sql`(org_id = get_user_org_id())`,
    }),
    check(
      'integrations_platform_type_check',
      sql`platform_type = ANY (ARRAY['shopify'::text, 'salla'::text, 'zid'::text, 'woocommerce'::text, 'standalone'::text, 'easyorders'::text])`,
    ),
    check(
      'integrations_cod_template_ar_variant_check',
      sql`cod_template_ar_variant = ANY (ARRAY['standard'::text, 'egyptian'::text, 'gulf'::text, 'short'::text])`,
    ),
    check(
      'integrations_cod_template_en_variant_check',
      sql`cod_template_en_variant = ANY (ARRAY['friendly'::text, 'professional'::text, 'direct'::text, 'short'::text])`,
    ),
  ],
);

export const integrationMonthlyUsage = pgTable(
  'integration_monthly_usage',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    orgId: uuid('org_id').notNull(),
    integrationId: uuid('integration_id').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    includedLimit: integer('included_limit').notNull(),
    consumedCount: integer('consumed_count').default(0).notNull(),
    blockedCount: integer('blocked_count').default(0).notNull(),
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
    index('idx_integration_monthly_usage_org_id').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_integration_monthly_usage_integration_id').using(
      'btree',
      table.integrationId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_integration_monthly_usage_period_start').using(
      'btree',
      table.periodStart.asc().nullsLast().op('date_ops'),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'integration_monthly_usage_org_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.integrationId, table.orgId],
      foreignColumns: [integrations.id, integrations.orgId],
      name: 'integration_monthly_usage_integration_id_fkey',
    }),
    unique('integration_monthly_usage_integration_id_period_start_key').on(
      table.integrationId,
      table.periodStart,
    ),
    pgPolicy('Service role updates integration monthly usage', {
      as: 'permissive',
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy('Multi-tenant integration monthly usage', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: sql`(org_id = get_user_org_id())`,
      withCheck: sql`(org_id = get_user_org_id())`,
    }),
    check(
      'integration_monthly_usage_included_limit_check',
      sql`included_limit > 0`,
    ),
    check(
      'integration_monthly_usage_consumed_count_check',
      sql`consumed_count >= 0`,
    ),
    check(
      'integration_monthly_usage_blocked_count_check',
      sql`blocked_count >= 0`,
    ),
  ],
);

export const billingFreePlanClaims = pgTable(
  'billing_free_plan_claims',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    orgId: uuid('org_id').notNull(),
    platformType: text('platform_type').notNull(),
    shopDomain: text('shop_domain').notNull(),
    claimedAt: timestamp('claimed_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
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
    index('idx_billing_free_plan_claims_org_id').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_billing_free_plan_claims_shop_domain').using(
      'btree',
      table.shopDomain.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'billing_free_plan_claims_org_id_fkey',
    }).onDelete('cascade'),
    unique('billing_free_plan_claims_platform_shop_key').on(
      table.platformType,
      table.shopDomain,
    ),
    pgPolicy('Service role manages free plan claims', {
      as: 'permissive',
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy('Multi-tenant free plan claims', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: sql`(org_id = get_user_org_id())`,
      withCheck: sql`(org_id = get_user_org_id())`,
    }),
    check(
      'billing_free_plan_claims_platform_type_check',
      sql`platform_type = ANY (ARRAY['shopify'::text, 'salla'::text, 'zid'::text, 'woocommerce'::text, 'standalone'::text, 'easyorders'::text])`,
    ),
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
    integrationId: uuid('integration_id').notNull(),
    externalOrderId: text('external_order_id').notNull(),
    orderNumber: text('order_number'),
    customerPhone: text('customer_phone').notNull(),
    customerName: text('customer_name'),
    customerEmail: text('customer_email'),
    totalPrice: numeric('total_price', { precision: 12, scale: 2 }),
    currency: text().default('SAR'),
    paymentMethod: text('payment_method'),
    rawPayload: jsonb('raw_payload'),
    isTest: boolean('is_test').default(false).notNull(),
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
    index('idx_orders_org_created_id').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
      table.createdAt.desc().nullsFirst().op('timestamptz_ops'),
      table.id.desc().nullsFirst().op('uuid_ops'),
    ),
    index('idx_orders_external_id').using(
      'btree',
      table.externalOrderId.asc().nullsLast().op('text_ops'),
    ),
    index('idx_orders_phone').using(
      'btree',
      table.customerPhone.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.integrationId, table.orgId],
      foreignColumns: [integrations.id, integrations.orgId],
      name: 'orders_integration_id_fkey',
    }),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'orders_org_id_fkey',
    }).onDelete('cascade'),
    unique('unique_external_order_per_integration').on(
      table.integrationId,
      table.externalOrderId,
    ),
    unique('orders_id_org_id_key').on(table.id, table.orgId),
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
      using: sql`(org_id = get_user_org_id())`,
      withCheck: sql`(org_id = get_user_org_id())`,
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
    status: verificationStatus().default('pending').notNull(),
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
    deliveredAt: timestamp('delivered_at', {
      withTimezone: true,
      mode: 'string',
    }),
    readAt: timestamp('read_at', {
      withTimezone: true,
      mode: 'string',
    }),
    expiredAt: timestamp('expired_at', { withTimezone: true, mode: 'string' }),
    followUpSentAt: timestamp('follow_up_sent_at', {
      withTimezone: true,
      mode: 'string',
    }),
    noReplyAt: timestamp('no_reply_at', {
      withTimezone: true,
      mode: 'string',
    }),
    followUpAttempts: integer('follow_up_attempts').default(0).notNull(),
    merchantCanceledAt: timestamp('merchant_canceled_at', {
      withTimezone: true,
      mode: 'string',
    }),
    cancellationSource: text('cancellation_source'),
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
    index('idx_verifications_org_created_id').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
      table.createdAt.desc().nullsFirst().op('timestamptz_ops'),
      table.id.desc().nullsFirst().op('uuid_ops'),
    ),
    index('idx_verifications_org_created_status').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
      table.status.asc().nullsLast().op('enum_ops'),
    ),
    index('idx_verifications_wa_id').using(
      'btree',
      table.waMessageId.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.orderId, table.orgId],
      foreignColumns: [orders.id, orders.orgId],
      name: 'verifications_order_id_fkey',
    }),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'verifications_org_id_fkey',
    }).onDelete('cascade'),
    unique('unique_active_verification_per_order').on(table.orderId),
    unique('verifications_id_org_id_key').on(table.id, table.orgId),
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
      using: sql`(org_id = get_user_org_id())`,
      withCheck: sql`(org_id = get_user_org_id())`,
    }),
  ],
);

export const verificationMessageDispatches = pgTable(
  'verification_message_dispatches',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    orgId: uuid('org_id').notNull(),
    integrationId: uuid('integration_id').notNull(),
    verificationId: uuid('verification_id').notNull(),
    dispatchKey: text('dispatch_key').notNull(),
    generation: integer('generation').notNull().default(1),
    accountingMode: text('accounting_mode')
      .$type<'periodic_plan' | 'prepaid_credit'>()
      .notNull()
      .default('periodic_plan'),
    kind: verificationDispatchKind().notNull(),
    state: verificationDispatchState().default('ready').notNull(),
    senderKind: text('sender_kind').default('akeed_system').notNull(),
    templateName: text('template_name'),
    languageCode: text('language_code'),
    providerMessageId: text('provider_message_id'),
    usagePeriodStart: date('usage_period_start', { mode: 'string' }),
    usageReserved: boolean('usage_reserved').default(false).notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    lastErrorCode: text('last_error_code'),
    leaseUntil: timestamp('lease_until', {
      withTimezone: true,
      mode: 'string',
    }),
    acceptedAt: timestamp('accepted_at', {
      withTimezone: true,
      mode: 'string',
    }),
    deliveredAt: timestamp('delivered_at', {
      withTimezone: true,
      mode: 'string',
    }),
    readAt: timestamp('read_at', {
      withTimezone: true,
      mode: 'string',
    }),
    failedAt: timestamp('failed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    resolvedAt: timestamp('resolved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    metadata: jsonb().default({}).notNull(),
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
    check('dispatch_generation_positive', sql`generation > 0`),
    check(
      'dispatch_accounting_mode_check',
      sql`accounting_mode IN ('periodic_plan', 'prepaid_credit')`,
    ),
    unique('dispatch_id_org_key').on(table.id, table.orgId),
    unique('dispatch_billable_identity_key').on(
      table.verificationId,
      table.kind,
      table.generation,
    ),
    unique('dispatch_reservation_identity_key').on(
      table.id,
      table.orgId,
      table.verificationId,
      table.kind,
      table.generation,
    ),
    uniqueIndex('dispatch_one_active_generation')
      .on(table.verificationId, table.kind)
      .where(
        sql`state IN ('ready', 'sending', 'outcome_unknown') OR (state = 'accepted' AND failed_at IS NULL)`,
      ),
    unique('verification_message_dispatches_dispatch_key_key').on(
      table.dispatchKey,
    ),
    uniqueIndex('verification_message_dispatches_provider_message_id_key')
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`),
    index('idx_verification_message_dispatches_verification').on(
      table.verificationId,
    ),
    index('idx_verification_message_dispatches_unknown').on(
      table.state,
      table.updatedAt,
    ),
    foreignKey({
      columns: [table.verificationId, table.orgId],
      foreignColumns: [verifications.id, verifications.orgId],
      name: 'verification_message_dispatches_verification_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.integrationId, table.orgId],
      foreignColumns: [integrations.id, integrations.orgId],
      name: 'verification_message_dispatches_integration_id_fkey',
    }),
    check(
      'verification_message_dispatches_sender_kind_check',
      sql`${table.senderKind} = 'akeed_system'`,
    ),
    check(
      'verification_message_dispatches_attempt_count_check',
      sql`${table.attemptCount} >= 0`,
    ),
    pgPolicy('Service role manages verification message dispatches', {
      as: 'permissive',
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy('Multi-tenant verification message dispatches', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(org_id = get_user_org_id())`,
    }),
  ],
);

export const webhookEventStatus = pgEnum('webhook_event_status', [
  'pending',
  'processing',
  'completed',
  'failed',
  'skipped',
]);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    platform: text('platform').notNull(),
    jobType: text('job_type').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    storeDomain: text('store_domain').notNull(),
    orgId: uuid('org_id'),
    integrationId: uuid('integration_id'),
    orderId: uuid('order_id'),
    status: webhookEventStatus('status').default('pending').notNull(),
    rawPayload: jsonb('raw_payload').notNull(),
    dispatchRequired: boolean('dispatch_required').default(false).notNull(),
    dispatchAttempts: integer('dispatch_attempts').default(0).notNull(),
    lastDispatchError: text('last_dispatch_error'),
    nextDispatchAt: timestamp('next_dispatch_at', {
      withTimezone: true,
      mode: 'string',
    }),
    dispatchLeaseUntil: timestamp('dispatch_lease_until', {
      withTimezone: true,
      mode: 'string',
    }),
    dispatchedAt: timestamp('dispatched_at', {
      withTimezone: true,
      mode: 'string',
    }),
    processingLeaseUntil: timestamp('processing_lease_until', {
      withTimezone: true,
      mode: 'string',
    }),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    processedAt: timestamp('processed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    receivedAt: timestamp('received_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
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
    index('idx_webhook_events_platform_idempotency').using(
      'btree',
      table.platform.asc().nullsLast().op('text_ops'),
      table.idempotencyKey.asc().nullsLast().op('text_ops'),
    ),
    index('idx_webhook_events_status').using(
      'btree',
      table.status.asc().nullsLast().op('enum_ops'),
    ),
    index('idx_webhook_events_dispatch_recovery').using(
      'btree',
      table.dispatchRequired.asc().nullsLast().op('bool_ops'),
      table.status.asc().nullsLast().op('enum_ops'),
      table.nextDispatchAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('idx_webhook_events_org_id').using(
      'btree',
      table.orgId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_webhook_events_store_domain').using(
      'btree',
      table.storeDomain.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'webhook_events_org_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.integrationId, table.orgId],
      foreignColumns: [integrations.id, integrations.orgId],
      name: 'webhook_events_integration_id_fkey',
    }),
    foreignKey({
      columns: [table.orderId, table.orgId],
      foreignColumns: [orders.id, orders.orgId],
      name: 'webhook_events_order_id_fkey',
    }),
    uniqueIndex('webhook_events_order_id_key')
      .on(table.orderId)
      .where(sql`${table.orderId} IS NOT NULL`),
    unique('webhook_events_source_idempotency_key').on(
      table.platform,
      table.storeDomain,
      table.idempotencyKey,
    ),
    check(
      'webhook_events_source_identity_pair_check',
      sql`(${table.orgId} IS NULL) = (${table.integrationId} IS NULL)`,
    ),
    pgPolicy('Service role manages webhook events', {
      as: 'permissive',
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

export const adminStoreLifecycles = pgTable(
  'admin_store_lifecycles',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    orgId: uuid('org_id').notNull(),
    integrationId: uuid('integration_id').notNull(),
    installedAt: timestamp('installed_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    uninstalledAt: timestamp('uninstalled_at', {
      withTimezone: true,
      mode: 'string',
    }),
    onboardingStartedAt: timestamp('onboarding_started_at', {
      withTimezone: true,
      mode: 'string',
    }),
    onboardingCompletedAt: timestamp('onboarding_completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    planSelectedAt: timestamp('plan_selected_at', {
      withTimezone: true,
      mode: 'string',
    }),
    testRequestedAt: timestamp('test_requested_at', {
      withTimezone: true,
      mode: 'string',
    }),
    testDeliveredAt: timestamp('test_delivered_at', {
      withTimezone: true,
      mode: 'string',
    }),
    firstEligibleOrderAt: timestamp('first_eligible_order_at', {
      withTimezone: true,
      mode: 'string',
    }),
    firstMessageDeliveredAt: timestamp('first_message_delivered_at', {
      withTimezone: true,
      mode: 'string',
    }),
    firstCustomerResponseAt: timestamp('first_customer_response_at', {
      withTimezone: true,
      mode: 'string',
    }),
    firstResolvedAt: timestamp('first_resolved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    paidSubscriptionActivatedAt: timestamp('paid_subscription_activated_at', {
      withTimezone: true,
      mode: 'string',
    }),
    provenance: jsonb().default({}).notNull(),
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
    index('idx_admin_store_lifecycles_org').on(table.orgId),
    index('idx_admin_store_lifecycles_installed').on(table.installedAt),
    index('idx_admin_store_lifecycles_integration_installed').on(
      table.integrationId,
      table.installedAt,
    ),
    uniqueIndex('uq_admin_store_lifecycles_current')
      .on(table.integrationId)
      .where(sql`${table.uninstalledAt} IS NULL`),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'admin_store_lifecycles_org_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.integrationId, table.orgId],
      foreignColumns: [integrations.id, integrations.orgId],
      name: 'admin_store_lifecycles_integration_id_fkey',
    }).onDelete('cascade'),
    pgPolicy('Service role manages admin store lifecycles', {
      as: 'permissive',
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

export const adminAccessAudit = pgTable(
  'admin_access_audit',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    userId: uuid('user_id'),
    action: text().notNull(),
    outcome: text().notNull(),
    requestId: text('request_id'),
    targetIntegrationId: uuid('target_integration_id'),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
  },
  (table) => [
    index('idx_admin_access_audit_user_created').on(
      table.userId,
      table.createdAt,
    ),
    pgPolicy('Service role manages admin access audit', {
      as: 'permissive',
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

export const adminFunnelMonthly = pgTable(
  'admin_funnel_monthly',
  {
    cohortMonth: date('cohort_month', { mode: 'string' }).notNull(),
    stage: text().notNull(),
    reachedCount: integer('reached_count').default(0).notNull(),
    durationSecondsTotal: numeric('duration_seconds_total', {
      precision: 20,
      scale: 0,
    })
      .default('0')
      .notNull(),
    durationSampleCount: integer('duration_sample_count').default(0).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).defaultNow(),
  },
  (table) => [
    unique('admin_funnel_monthly_cohort_stage_key').on(
      table.cohortMonth,
      table.stage,
    ),
    pgPolicy('Service role manages admin funnel monthly', {
      as: 'permissive',
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

export const creditAccountStatus = pgEnum('credit_account_status', [
  'pending_approval',
  'active',
  'suspended',
]);
export const creditReservationStatus = pgEnum('credit_reservation_status', [
  'held',
  'consumed',
  'released',
]);
export const creditLedgerType = pgEnum('credit_ledger_type', [
  'free_grant',
  'purchase',
  'consumption',
  'failure_reversal',
  'refund_reversal',
  'chargeback_reversal',
  'chargeback_reinstatement',
  'staff_adjustment',
]);
export const paymentPurchaseStatus = pgEnum('payment_purchase_status', [
  'pending',
  'successful',
  'failed',
  'canceled',
  'expired',
  'refunded',
]);
export const paymentDisputeStatus = pgEnum('payment_dispute_status', [
  'none',
  'open',
  'lost',
  'won',
]);
export const creditAccounts = pgTable(
  'credit_accounts',
  {
    orgId: uuid('org_id').primaryKey(),
    status: creditAccountStatus('status').notNull().default('pending_approval'),
    postedBalance: integer('posted_balance').notNull().default(0),
    heldCredits: integer('held_credits').notNull().default(0),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    approvalReason: text('approval_reason'),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [organizations.id],
      name: 'credit_accounts_org_id_fkey',
    }),
    check('credit_accounts_held_credits_check', sql`held_credits >= 0`),
    check('credit_accounts_version_check', sql`version >= 0`),
    check(
      'credit_account_approval_check',
      sql`((approved_by IS NULL AND approved_at IS NULL AND approval_reason IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_reason IS NOT NULL AND length(trim(approval_reason)) > 0))`,
    ),
    index('credit_account_status_idx').on(table.status),
    pgPolicy('credit_service_access', {
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy('credit_tenant_read', {
      for: 'select',
      to: ['authenticated'],
      using: sql`org_id = get_user_org_id()`,
    }),
  ],
).enableRLS();
export const paymentPurchases = pgTable(
  'payment_purchases',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    orgId: uuid('org_id').notNull(),
    reference: text('reference').notNull(),
    provider: text('provider').notNull(),
    mode: text('mode').notNull(),
    requestKey: text('request_key').notNull(),
    requestHash: text('request_hash').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
    totalMinor: integer('total_minor').notNull(),
    currency: text('currency').notNull(),
    status: paymentPurchaseStatus('status').notNull().default('pending'),
    disputeStatus: paymentDisputeStatus('dispute_status')
      .notNull()
      .default('none'),
    providerIntentionId: text('provider_intention_id'),
    providerOrderId: text('provider_order_id'),
    providerTransactionId: text('provider_transaction_id'),
    checkoutExpiresAt: timestamp('checkout_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    refundedMinor: integer('refunded_minor').notNull().default(0),
    reconciliationRequired: boolean('reconciliation_required')
      .notNull()
      .default(false),
    reconciliationCode: text('reconciliation_code'),
    reconciliationAttempts: integer('reconciliation_attempts')
      .notNull()
      .default(0),
    nextReconciliationAt: timestamp('next_reconciliation_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [creditAccounts.orgId],
      name: 'payment_purchases_org_id_fkey',
    }),
    unique('payment_purchases_reference_key').on(table.reference),
    check(
      'payment_purchases_reference_check',
      sql`length(trim(reference)) > 0`,
    ),
    check(
      'payment_purchases_provider_check',
      sql`provider ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    check('payment_purchases_mode_check', sql`mode IN ('test', 'live')`),
    check(
      'payment_purchases_request_key_check',
      sql`length(trim(request_key)) > 0`,
    ),
    check(
      'payment_purchases_request_hash_check',
      sql`request_hash ~ '^[a-f0-9]{64}$'`,
    ),
    check('payment_purchases_quantity_check', sql`quantity > 0`),
    check(
      'payment_purchases_unit_price_minor_check',
      sql`unit_price_minor > 0`,
    ),
    check('payment_purchases_total_minor_check', sql`total_minor > 0`),
    check('payment_purchases_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check(
      'payment_purchases_reconciliation_code_check',
      sql`reconciliation_code ~ '^[a-z0-9_]{1,80}$'`,
    ),
    check(
      'payment_purchases_reconciliation_attempts_check',
      sql`reconciliation_attempts >= 0`,
    ),
    unique('payment_purchase_id_org_key').on(table.id, table.orgId),
    unique('payment_purchase_request_key').on(table.orgId, table.requestKey),
    check(
      'payment_purchase_total_check',
      sql`(quantity::bigint * unit_price_minor::bigint = total_minor)`,
    ),
    check(
      'payment_purchase_refund_check',
      sql`(refunded_minor >= 0 AND refunded_minor <= total_minor)`,
    ),
    check(
      'payment_purchase_provider_ids_check',
      sql`((provider_intention_id IS NULL OR length(trim(provider_intention_id)) > 0) AND (provider_order_id IS NULL OR length(trim(provider_order_id)) > 0) AND (provider_transaction_id IS NULL OR length(trim(provider_transaction_id)) > 0))`,
    ),
    uniqueIndex('payment_purchase_intention_key')
      .on(table.provider, table.providerIntentionId)
      .where(sql`provider_intention_id IS NOT NULL`),
    uniqueIndex('payment_purchase_order_key')
      .on(table.provider, table.providerOrderId)
      .where(sql`provider_order_id IS NOT NULL`),
    uniqueIndex('payment_purchase_transaction_key')
      .on(table.provider, table.providerTransactionId)
      .where(sql`provider_transaction_id IS NOT NULL`),
    index('payment_purchase_history_idx').on(
      table.orgId,
      table.createdAt,
      table.id,
    ),
    index('payment_purchase_reconciliation_idx')
      .on(table.nextReconciliationAt, table.createdAt)
      .where(sql`status = 'pending' OR reconciliation_required`),
    pgPolicy('credit_service_access', {
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy('credit_tenant_read', {
      for: 'select',
      to: ['authenticated'],
      using: sql`org_id = get_user_org_id()`,
    }),
  ],
).enableRLS();
export const creditReservations = pgTable(
  'credit_reservations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    orgId: uuid('org_id').notNull(),
    dispatchId: uuid('dispatch_id').notNull(),
    verificationId: uuid('verification_id').notNull(),
    kind: verificationDispatchKind('kind').notNull(),
    generation: integer('generation').notNull(),
    quantity: integer('quantity').notNull(),
    billableKey: text('billable_key').notNull(),
    status: creditReservationStatus('status').notNull().default('held'),
    resolvedAt: timestamp('resolved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    resolutionCode: text('resolution_code'),
    resolvedBy: uuid('resolved_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [creditAccounts.orgId],
      name: 'credit_reservations_org_id_fkey',
    }),
    check(
      'credit_reservations_kind_check',
      sql`kind IN ('initial', 'follow_up')`,
    ),
    check('credit_reservations_generation_check', sql`generation > 0`),
    check('credit_reservations_quantity_check', sql`quantity > 0`),
    check(
      'credit_reservations_billable_key_check',
      sql`length(trim(billable_key)) > 0`,
    ),
    check(
      'credit_reservations_resolution_code_check',
      sql`resolution_code ~ '^[a-z0-9_]{1,80}$'`,
    ),
    unique('credit_reservation_id_org_key').on(table.id, table.orgId),
    unique('credit_reservation_dispatch_key').on(table.dispatchId),
    unique('credit_reservation_billable_key').on(
      table.orgId,
      table.billableKey,
    ),
    unique('credit_reservation_identity_key').on(
      table.verificationId,
      table.kind,
      table.generation,
    ),
    foreignKey({
      columns: [
        table.dispatchId,
        table.orgId,
        table.verificationId,
        table.kind,
        table.generation,
      ],
      foreignColumns: [
        verificationMessageDispatches.id,
        verificationMessageDispatches.orgId,
        verificationMessageDispatches.verificationId,
        verificationMessageDispatches.kind,
        verificationMessageDispatches.generation,
      ],
      name: 'credit_reservation_dispatch_fk',
    }),
    check(
      'credit_reservation_resolution_check',
      sql`((status = 'held' AND resolved_at IS NULL AND resolution_code IS NULL AND resolved_by IS NULL) OR (status <> 'held' AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL))`,
    ),
    index('credit_reservation_held_idx')
      .on(table.orgId, table.createdAt)
      .where(sql`status = 'held'`),
    pgPolicy('credit_service_access', {
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy('credit_tenant_read', {
      for: 'select',
      to: ['authenticated'],
      using: sql`org_id = get_user_org_id()`,
    }),
  ],
).enableRLS();
export const creditLedgerEntries = pgTable(
  'credit_ledger_entries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    orgId: uuid('org_id').notNull(),
    type: creditLedgerType('type').notNull(),
    quantity: integer('quantity').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    reservationId: uuid('reservation_id'),
    dispatchId: uuid('dispatch_id'),
    purchaseId: uuid('purchase_id'),
    sourceLedgerEntryId: uuid('source_ledger_entry_id'),
    sourceReference: text('source_reference'),
    actorId: uuid('actor_id'),
    reason: text('reason').notNull(),
    postedBalanceBefore: integer('posted_balance_before').notNull(),
    postedBalanceAfter: integer('posted_balance_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [creditAccounts.orgId],
      name: 'credit_ledger_entries_org_id_fkey',
    }),
    check('credit_ledger_entries_quantity_check', sql`quantity <> 0`),
    check(
      'credit_ledger_entries_idempotency_key_check',
      sql`length(trim(idempotency_key)) > 0`,
    ),
    check('credit_ledger_entries_reason_check', sql`length(trim(reason)) > 0`),
    unique('credit_ledger_id_org_key').on(table.id, table.orgId),
    unique('credit_ledger_idempotency_key').on(
      table.orgId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.reservationId, table.orgId],
      foreignColumns: [creditReservations.id, creditReservations.orgId],
      name: 'credit_ledger_reservation_fk',
    }),
    foreignKey({
      columns: [table.dispatchId, table.orgId],
      foreignColumns: [
        verificationMessageDispatches.id,
        verificationMessageDispatches.orgId,
      ],
      name: 'credit_ledger_dispatch_fk',
    }),
    foreignKey({
      columns: [table.purchaseId, table.orgId],
      foreignColumns: [paymentPurchases.id, paymentPurchases.orgId],
      name: 'credit_ledger_purchase_fk',
    }),
    foreignKey({
      columns: [table.sourceLedgerEntryId, table.orgId],
      foreignColumns: [table.id, table.orgId],
      name: 'credit_ledger_source_fk',
    }),
    check(
      'credit_ledger_projection_check',
      sql`(posted_balance_before::bigint + quantity::bigint = posted_balance_after)`,
    ),
    check(
      'credit_ledger_sign_check',
      sql`((type IN ('free_grant', 'purchase', 'failure_reversal', 'chargeback_reinstatement') AND quantity > 0) OR (type IN ('consumption', 'refund_reversal', 'chargeback_reversal') AND quantity < 0) OR type = 'staff_adjustment')`,
    ),
    check(
      'credit_ledger_source_check',
      sql`(
    (type IN ('free_grant', 'staff_adjustment') AND reservation_id IS NULL AND dispatch_id IS NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL AND actor_id IS NOT NULL)
    OR (type = 'purchase' AND purchase_id IS NOT NULL AND reservation_id IS NULL AND dispatch_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL)
    OR (type = 'consumption' AND reservation_id IS NOT NULL AND dispatch_id IS NOT NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NULL AND source_reference IS NULL)
    OR (type = 'failure_reversal' AND reservation_id IS NOT NULL AND dispatch_id IS NOT NULL AND purchase_id IS NULL AND source_ledger_entry_id IS NOT NULL AND source_reference IS NULL)
    OR (type IN ('refund_reversal', 'chargeback_reversal', 'chargeback_reinstatement') AND purchase_id IS NOT NULL AND reservation_id IS NULL AND dispatch_id IS NULL AND source_ledger_entry_id IS NOT NULL AND source_reference IS NOT NULL AND length(trim(source_reference)) > 0)
  )`,
    ),
    uniqueIndex('credit_ledger_free_grant_key')
      .on(table.orgId)
      .where(sql`type = 'free_grant'`),
    uniqueIndex('credit_ledger_purchase_key')
      .on(table.purchaseId)
      .where(sql`type = 'purchase'`),
    uniqueIndex('credit_ledger_reservation_source_key')
      .on(table.reservationId, table.type)
      .where(sql`type IN ('consumption', 'failure_reversal')`),
    uniqueIndex('credit_ledger_reversal_source_key')
      .on(table.purchaseId, table.type, table.sourceReference)
      .where(
        sql`type IN ('refund_reversal', 'chargeback_reversal', 'chargeback_reinstatement')`,
      ),
    index('credit_ledger_history_idx').on(
      table.orgId,
      table.createdAt,
      table.id,
    ),
    pgPolicy('credit_service_access', {
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy('credit_tenant_read', {
      for: 'select',
      to: ['authenticated'],
      using: sql`org_id = get_user_org_id()`,
    }),
  ],
).enableRLS();
export const paymentProviderEvents = pgTable(
  'payment_provider_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    orgId: uuid('org_id'),
    purchaseId: uuid('purchase_id'),
    provider: text('provider').notNull(),
    providerIntentionId: text('provider_intention_id'),
    providerOrderId: text('provider_order_id'),
    providerTransactionId: text('provider_transaction_id'),
    fingerprint: text('fingerprint').notNull(),
    payloadHash: text('payload_hash').notNull(),
    verified: boolean('verified').notNull().default(false),
    resultCode: text('result_code').notNull(),
    errorCode: text('error_code'),
    retryCount: integer('retry_count').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', {
      withTimezone: true,
      mode: 'string',
    }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'payment_provider_events_provider_check',
      sql`provider ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    check(
      'payment_provider_events_fingerprint_check',
      sql`fingerprint ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'payment_provider_events_payload_hash_check',
      sql`payload_hash ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'payment_provider_events_result_code_check',
      sql`result_code ~ '^[a-z0-9_]{1,80}$'`,
    ),
    check(
      'payment_provider_events_error_code_check',
      sql`error_code ~ '^[a-z0-9_]{1,80}$'`,
    ),
    check('payment_provider_events_retry_count_check', sql`retry_count >= 0`),
    unique('payment_event_fingerprint_key').on(
      table.provider,
      table.fingerprint,
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [creditAccounts.orgId],
      name: 'payment_event_org_fk',
    }),
    foreignKey({
      columns: [table.purchaseId, table.orgId],
      foreignColumns: [paymentPurchases.id, paymentPurchases.orgId],
      name: 'payment_event_purchase_fk',
    }),
    check(
      'payment_event_tenant_check',
      sql`(purchase_id IS NULL OR org_id IS NOT NULL)`,
    ),
    index('payment_event_retry_idx')
      .on(table.nextRetryAt, table.receivedAt)
      .where(sql`processed_at IS NULL`),
    index('payment_event_purchase_idx').on(
      table.orgId,
      table.purchaseId,
      table.receivedAt,
    ),
    pgPolicy('credit_service_access', {
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export const billingSettlementReports = pgTable(
  'billing_settlement_reports',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    provider: text('provider').notNull().default('paymob'),
    providerReportId: text('provider_report_id').notNull(),
    revision: integer('revision').notNull().default(1),
    supersedesId: uuid('supersedes_id'),
    periodStart: timestamp('period_start', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    periodEnd: timestamp('period_end', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    settledAt: timestamp('settled_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    currency: text('currency').notNull(),
    transactionCount: integer('transaction_count').notNull(),
    grossMinor: numeric('gross_minor', { mode: 'number' }).notNull(),
    refundedMinor: numeric('refunded_minor', { mode: 'number' }).notNull(),
    chargebackMinor: numeric('chargeback_minor', { mode: 'number' }).notNull(),
    feeMinor: numeric('fee_minor', { mode: 'number' }).notNull(),
    vatMinor: numeric('vat_minor', { mode: 'number' }).notNull(),
    netMinor: numeric('net_minor', { mode: 'number' }).notNull(),
    actorId: uuid('actor_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    evidence: text('evidence').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.supersedesId],
      foreignColumns: [table.id],
      name: 'billing_settlement_reports_supersedes_id_fkey',
    }),
    unique('billing_settlement_report_revision_key').on(
      table.provider,
      table.providerReportId,
      table.revision,
    ),
    unique('billing_settlement_actor_idempotency_key').on(
      table.actorId,
      table.idempotencyKey,
    ),
    uniqueIndex('billing_settlement_supersedes_key')
      .on(table.supersedesId)
      .where(sql`supersedes_id IS NOT NULL`),
    index('billing_settlement_period_idx').on(
      table.periodStart,
      table.periodEnd,
      table.createdAt,
    ),
    pgPolicy('billing_observability_service_access', {
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export const billingReconciliationRuns = pgTable(
  'billing_reconciliation_runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    runKey: text('run_key').notNull(),
    trigger: text('trigger').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull().default('queued'),
    settlementId: uuid('settlement_id').references(
      () => billingSettlementReports.id,
    ),
    triggeredBy: uuid('triggered_by'),
    reason: text('reason'),
    candidates: integer('candidates').notNull().default(0),
    attempted: integer('attempted').notNull().default(0),
    resolved: integer('resolved').notNull().default(0),
    deferred: integer('deferred').notNull().default(0),
    findingsOpened: integer('findings_opened').notNull().default(0),
    findingsResolved: integer('findings_resolved').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('billing_reconciliation_runs_run_key_key').on(table.runKey),
    index('billing_reconciliation_run_created_idx').on(
      table.createdAt,
      table.id,
    ),
    pgPolicy('billing_observability_service_access', {
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export const billingReconciliationAttempts = pgTable(
  'billing_reconciliation_attempts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => billingReconciliationRuns.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => creditAccounts.orgId),
    purchaseId: uuid('purchase_id'),
    targetKind: text('target_kind').notNull(),
    targetKey: text('target_key').notNull(),
    outcome: text('outcome').notNull(),
    errorCode: text('error_code'),
    durationMs: integer('duration_ms').notNull().default(0),
    attemptedAt: timestamp('attempted_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.purchaseId, table.orgId],
      foreignColumns: [paymentPurchases.id, paymentPurchases.orgId],
      name: 'billing_reconciliation_attempt_purchase_fk',
    }),
    unique('billing_reconciliation_attempt_target_key').on(
      table.runId,
      table.targetKind,
      table.targetKey,
    ),
    index('billing_reconciliation_attempt_retention_idx').on(table.attemptedAt),
    index('billing_reconciliation_attempt_purchase_idx').on(
      table.orgId,
      table.purchaseId,
      table.attemptedAt,
    ),
    pgPolicy('billing_observability_service_access', {
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export const billingReconciliationFindings = pgTable(
  'billing_reconciliation_findings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    fingerprint: text('fingerprint').notNull(),
    orgId: uuid('org_id').references(() => creditAccounts.orgId),
    purchaseId: uuid('purchase_id'),
    settlementId: uuid('settlement_id').references(
      () => billingSettlementReports.id,
    ),
    code: text('code').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull().default('open'),
    firstSeenAt: timestamp('first_seen_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    retryCount: integer('retry_count').notNull().default(0),
    nextAction: text('next_action').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'string',
    }),
    safeContext: jsonb('safe_context').notNull().default({}),
    lastRunId: uuid('last_run_id').references(
      () => billingReconciliationRuns.id,
      { onDelete: 'set null' },
    ),
    resolvedAt: timestamp('resolved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('billing_reconciliation_findings_fingerprint_key').on(
      table.fingerprint,
    ),
    foreignKey({
      columns: [table.purchaseId, table.orgId],
      foreignColumns: [paymentPurchases.id, paymentPurchases.orgId],
      name: 'billing_reconciliation_finding_purchase_fk',
    }),
    index('billing_reconciliation_finding_queue_idx').on(
      table.status,
      table.severity,
      table.lastSeenAt,
      table.id,
    ),
    index('billing_reconciliation_finding_org_idx').on(
      table.orgId,
      table.status,
      table.lastSeenAt,
    ),
    pgPolicy('billing_observability_service_access', {
      for: 'all',
      to: ['service_role'],
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();
