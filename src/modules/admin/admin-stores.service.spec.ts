import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  parseStandaloneCreditBillingConfig,
  STANDALONE_CREDIT_BILLING_CONFIG,
} from '../../shared/config/standalone-credit-billing.config';
import { AdminHealthRuleService } from './admin-health-rule.service';
import type {
  AdminStoreDetailQueryRow,
  AdminStoreQueryRow,
} from './admin-query.repository';
import { AdminStoresService } from './admin-stores.service';

const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function shopifyRow(
  overrides: Partial<AdminStoreQueryRow> = {},
): AdminStoreQueryRow {
  return {
    integration_id: '00000000-0000-4000-8000-000000000001',
    org_id: 'org-shopify',
    platform_type: 'shopify',
    organization_name: 'Shopify Org',
    store_name: 'Shopify Store',
    shop_domain: 'example.myshopify.com',
    country_code: 'SA',
    timezone: 'Asia/Riyadh',
    is_active: true,
    onboarding_status: 'completed',
    plan: 'basic',
    subscription_status: 'active',
    auto_confirmation_enabled: true,
    installed_at: recent,
    uninstalled_at: null,
    onboarding_started_at: recent,
    onboarding_completed_at: recent,
    plan_selected_at: recent,
    test_requested_at: null,
    test_delivered_at: null,
    first_eligible_order_at: recent,
    first_message_delivered_at: recent,
    first_customer_response_at: recent,
    first_resolved_at: recent,
    paid_subscription_activated_at: null,
    provenance: {},
    usage_used: 30,
    usage_limit: 100,
    last_activity_at: recent,
    failed_24h: 0,
    total_24h: 3,
    failed_webhooks_1h: 0,
    has_lifecycle: true,
    derived_first_eligible_order_at: recent,
    derived_first_resolved_at: recent,
    credit_account_status: null,
    credit_posted_balance: null,
    credit_held_credits: null,
    ...overrides,
  };
}

function standaloneRow(
  overrides: Partial<AdminStoreQueryRow> = {},
): AdminStoreQueryRow {
  return shopifyRow({
    integration_id: '00000000-0000-4000-8000-000000000002',
    org_id: 'org-standalone',
    platform_type: 'standalone',
    organization_name: 'Standalone Org',
    store_name: 'Standalone Store',
    shop_domain: 'standalone:org-standalone',
    plan: null,
    subscription_status: null,
    usage_used: 0,
    usage_limit: 0,
    has_lifecycle: false,
    onboarding_completed_at: null,
    first_eligible_order_at: null,
    first_resolved_at: null,
    credit_account_status: 'active',
    credit_posted_balance: 500,
    credit_held_credits: 20,
    ...overrides,
  });
}

function detailRow(row: AdminStoreQueryRow): AdminStoreDetailQueryRow {
  return {
    ...row,
    owner_email: 'owner@example.com',
    default_language: 'auto',
    follow_up_enabled: true,
    follow_up_delay_minutes: 120,
    escalation_enabled: true,
    quiet_hours_enabled: false,
    quiet_hours_start: null,
    quiet_hours_end: null,
    send_delay_minutes: 0,
    shipping_currency: 'SAR',
    last_synced_at: null,
    billing_activated_at: null,
    created_at: recent,
  };
}

function createService(repository: Record<string, jest.Mock>) {
  const config = new ConfigService({
    [STANDALONE_CREDIT_BILLING_CONFIG]: parseStandaloneCreditBillingConfig({}),
  });
  return new AdminStoresService(
    repository as never,
    new AdminHealthRuleService(config),
    config,
  );
}

describe('AdminStoresService', () => {
  it('lists stores from every platform with platform-aware billing', async () => {
    const service = createService({
      findStores: jest.fn().mockResolvedValue([shopifyRow(), standaloneRow()]),
    });

    const result = await service.getStores({});
    const shopify = result.data.find((store) => store.platform === 'shopify');
    const standalone = result.data.find(
      (store) => store.platform === 'standalone',
    );

    expect(result.data).toHaveLength(2);
    expect(shopify?.billing).toMatchObject({
      model: 'plan',
      plan: 'basic',
      usage: { used: 30, limit: 100, percent: 30 },
    });
    expect(shopify?.shop_domain).toBe('example.myshopify.com');
    expect(standalone?.billing).toEqual({
      model: 'credits',
      account_status: 'active',
      available: 480,
      held: 20,
      debt: 0,
      balance_state: 'ok',
    });
    expect(standalone?.shop_domain).toBeNull();
    expect(standalone?.source_identity).toBe('standalone:org-standalone');
  });

  it('filters by platform', async () => {
    const service = createService({
      findStores: jest.fn().mockResolvedValue([shopifyRow(), standaloneRow()]),
    });

    const result = await service.getStores({ platform: 'standalone' });

    expect(result.data.map((store) => store.platform)).toEqual(['standalone']);
  });

  it('derives standalone lifecycle from verifications and flags it as estimated', async () => {
    const service = createService({
      findStores: jest.fn().mockResolvedValue([standaloneRow()]),
    });

    const [store] = (await service.getStores({})).data;

    expect(store.lifecycle_status).toBe('active');
    expect(store.activated_at).toBe(recent);
    expect(store.data_quality).toEqual(['estimated_historical_data']);
  });

  it('raises credit health signals instead of subscription rules', async () => {
    const service = createService({
      findStores: jest.fn().mockResolvedValue([
        standaloneRow({
          credit_posted_balance: -5,
          credit_held_credits: 0,
          subscription_status: 'frozen',
        }),
      ]),
    });

    const [store] = (await service.getStores({})).data;

    expect(store.billing).toMatchObject({
      model: 'credits',
      debt: 5,
      balance_state: 'debt',
    });
    expect(store.health.status).toBe('critical');
    expect(store.health.signals).toContain('credits_exhausted');
    expect(store.health.signals).not.toContain('subscription_blocked');
  });

  it('returns store details with verification totals and milestones', async () => {
    const service = createService({
      findStoreById: jest.fn().mockResolvedValue(detailRow(standaloneRow())),
      findStoreVerificationTotals: jest.fn().mockResolvedValue([
        { status: 'confirmed', is_test: false, count: 4 },
        { status: 'canceled', is_test: false, count: 1 },
        { status: 'confirmed', is_test: true, count: 2 },
      ]),
    });

    const { store } = await service.getStore(
      '00000000-0000-4000-8000-000000000002',
    );

    expect(store.owner_email).toBe('owner@example.com');
    expect(store.verification_totals).toMatchObject({
      total: 5,
      test: 2,
      by_status: { confirmed: 4, canceled: 1 },
    });
    expect(
      store.milestones.find((item) => item.key === 'first_real_cod_resolved'),
    ).toEqual({ key: 'first_real_cod_resolved', at: recent, estimated: true });
  });

  it('throws when the store does not exist', async () => {
    const service = createService({
      findStoreById: jest.fn().mockResolvedValue(null),
    });

    await expect(service.getStore('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.getStoreVerifications('missing', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pages verifications and never exposes the raw phone', async () => {
    const verification = (id: string, createdAt: string) => ({
      id,
      status: 'confirmed',
      metadata: {},
      order_number: '#1001',
      external_order_id: 'ext-1',
      is_test: false,
      customer_name: 'Customer',
      customer_phone: '+966512345123',
      total_price: '120.00',
      currency: 'SAR',
      attempts: 1,
      follow_up_attempts: 0,
      template_name: 'cod_verification',
      language_code: 'ar',
      cancellation_source: null,
      created_at: createdAt,
      last_sent_at: createdAt,
      delivered_at: null,
      read_at: null,
      confirmed_at: createdAt,
      canceled_at: null,
      expired_at: null,
      no_reply_at: null,
      follow_up_sent_at: null,
      updated_at: createdAt,
    });
    const findStoreVerifications = jest.fn().mockResolvedValue({
      rows: [
        verification('v-2', '2026-09-02T00:00:00Z'),
        verification('v-1', '2026-09-01T00:00:00Z'),
      ],
      totalCount: 7,
    });
    const service = createService({
      findStoreById: jest.fn().mockResolvedValue(detailRow(shopifyRow())),
      findStoreVerifications,
    });

    const result = await service.getStoreVerifications('store', {
      limit: 1,
      status: ['confirmed'],
    });

    expect(findStoreVerifications).toHaveBeenCalledWith('store', {
      statuses: ['confirmed'],
      includeTest: false,
      cursor: undefined,
      limit: 2,
    });
    expect(result.data).toHaveLength(1);
    expect(result.total_count).toBe(7);
    expect(result.next_cursor).not.toBeNull();
    expect(result.data[0].customer_phone_masked).toBe('+9665•••••123');
    expect(JSON.stringify(result)).not.toContain('+966512345123');
  });
});
