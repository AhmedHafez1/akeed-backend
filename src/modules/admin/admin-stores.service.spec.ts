import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  parseStandaloneCreditBillingConfig,
  STANDALONE_CREDIT_BILLING_CONFIG,
} from '../../shared/config/standalone-credit-billing.config';
import { AdminHealthRuleService } from './admin-health-rule.service';
import type {
  AdminStoreDerivation,
  AdminStoreDetailQueryRow,
  AdminStorePageRow,
  AdminStoreSummaryRow,
} from './admin-query.repository';
import {
  AdminStoresService,
  toOrderIntakeView,
  validTimeZone,
} from './admin-stores.service';

const recent = '2026-09-14T10:00:00.000000+00';
const SHOPIFY_ID = '00000000-0000-4000-8000-000000000001';
const STANDALONE_ID = '00000000-0000-4000-8000-000000000002';

function shopifyRow(
  overrides: Partial<AdminStorePageRow> = {},
): AdminStorePageRow {
  return {
    integration_id: SHOPIFY_ID,
    org_id: 'org-shopify',
    platform_type: 'shopify',
    organization_name: 'Shopify Org',
    store_name: 'Shopify Store',
    shop_domain: 'example.myshopify.com',
    country_code: 'SA',
    top_customer_country: 'SA',
    top_customer_country_share: 100,
    customer_country_count: 1,
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
    intake_received_24h: 0,
    intake_eligible_24h: 0,
    intake_skipped_24h: 0,
    intake_base_received: 0,
    intake_base_eligible: 0,
    intake_top_skip_reason: null,
    intake_top_payment_method: null,
    uninstall_plan_id: null,
    uninstall_was_active: false,
    uninstall_paid_through_at: null,
    previous_install_at: null,
    previous_uninstalled_at: null,
    previous_plan_id: null,
    is_credit: false,
    usage_limit_effective: 100,
    usage_percent: 30,
    credit_available: 0,
    credit_debt: 0,
    credit_balance_state: null,
    first_eligible_order_at_effective: recent,
    first_resolved_at_effective: recent,
    first_eligible_estimated: false,
    first_resolved_estimated: false,
    data_quality_estimated: false,
    lifecycle_status: 'active',
    uninstall_plan_paid: false,
    critical_signals: [],
    attention_signals: [],
    health_status: 'healthy',
    sort_value: recent,
    ...overrides,
  };
}

function standaloneRow(
  overrides: Partial<AdminStorePageRow> = {},
): AdminStorePageRow {
  return shopifyRow({
    integration_id: STANDALONE_ID,
    org_id: 'org-standalone',
    platform_type: 'standalone',
    organization_name: 'Standalone Org',
    store_name: null,
    shop_domain: 'standalone:org-standalone',
    plan: null,
    subscription_status: null,
    usage_used: 0,
    usage_limit: 0,
    usage_limit_effective: 0,
    usage_percent: 0,
    has_lifecycle: false,
    first_resolved_at: null,
    credit_account_status: 'active',
    credit_posted_balance: 500,
    credit_held_credits: 20,
    is_credit: true,
    credit_available: 480,
    credit_balance_state: 'ok',
    first_resolved_estimated: true,
    data_quality_estimated: true,
    ...overrides,
  });
}

function detailRow(row: AdminStorePageRow): AdminStoreDetailQueryRow {
  return {
    ...row,
    owner_email: 'owner@example.com',
    merchant_whatsapp_phone: '+966500000001',
    default_language: 'auto',
    follow_up_enabled: false,
    follow_up_delay_minutes: 120,
    escalation_enabled: true,
    acknowledgment_enabled: false,
    auto_cancel_enabled: false,
    quiet_hours_enabled: false,
    quiet_hours_start: null,
    quiet_hours_end: null,
    send_delay_minutes: 0,
    shipping_currency: 'SAR',
    last_synced_at: null,
    billing_activated_at: null,
    paid_through_at: null,
    created_at: recent,
  };
}

const summary: AdminStoreSummaryRow = {
  currently_installed: 2,
  onboarding: 0,
  activated: 2,
  inactive: 0,
  uninstalled: 0,
  healthy: 1,
  attention_required: 0,
  critical: 1,
};

function createService(repository: Record<string, jest.Mock>) {
  const config = new ConfigService({
    [STANDALONE_CREDIT_BILLING_CONFIG]: parseStandaloneCreditBillingConfig({}),
  });
  return new AdminStoresService(
    {
      findStoreOrderIntake: jest
        .fn()
        .mockResolvedValue({ days: [], reasons: [], paymentMethods: [] }),
      ...repository,
    } as never,
    new AdminHealthRuleService(config),
    config,
  );
}

describe('AdminStoresService', () => {
  it('maps SQL rows to platform-aware store views', async () => {
    const service = createService({
      findStorePage: jest.fn().mockResolvedValue({
        summary,
        rows: [shopifyRow(), standaloneRow()],
      }),
    });

    const result = await service.getStores({});
    const [shopify, standalone] = result.data;

    expect(result.summary).toEqual(summary);
    expect(shopify.billing).toEqual({
      model: 'plan',
      plan: 'basic',
      subscription_status: 'active',
      usage: {
        used: 30,
        limit: 100,
        remaining: 70,
        percent: 30,
        pools: {
          akeed: { used: 30, limit: 100, remaining: 70 },
          ownNumber: { used: 0, limit: 300, remaining: 300 },
        },
      },
    });
    expect(shopify.shop_domain).toBe('example.myshopify.com');
    expect(shopify.customer_countries).toEqual({
      top: 'SA',
      share: 100,
      count: 1,
    });
    expect(standalone).toMatchObject({
      platform: 'standalone',
      store_name: 'Standalone Org',
      shop_domain: null,
      source_identity: 'standalone:org-standalone',
      activated_at: recent,
      data_quality: ['estimated_historical_data'],
      billing: {
        model: 'credits',
        account_status: 'active',
        available: 480,
        held: 20,
        debt: 0,
        balance_state: 'ok',
      },
    });
  });

  it.each([
    [0, 0, 960],
    [1, 1, 961],
    // A stray value never inflates the merchant-visible balance.
    [2, 0, 960],
  ])(
    'shows stored credits plus a spare of %s as the merchant sees them',
    async (stored, spare, displayed) => {
      const service = createService({
        findStorePage: jest.fn().mockResolvedValue({
          summary,
          rows: [standaloneRow({ credit_spare: stored })],
        }),
      });
      const [store] = (await service.getStores({})).data;
      expect(store.billing).toMatchObject({
        model: 'credits',
        available: 480,
        spare,
        displayed_available: displayed,
      });
    },
  );

  it('reports critical signals ahead of attention signals', async () => {
    const service = createService({
      findStorePage: jest.fn().mockResolvedValue({
        summary,
        rows: [
          standaloneRow({
            health_status: 'critical',
            critical_signals: ['credits_exhausted'],
            attention_signals: ['auto_confirmation_disabled'],
          }),
        ],
      }),
    });

    const [store] = (await service.getStores({})).data;

    expect(store.health).toEqual({
      status: 'critical',
      top_signal: 'credits_exhausted',
      signal_count: 2,
      signals: ['credits_exhausted', 'auto_confirmation_disabled'],
      levels: {
        credits_exhausted: 'critical',
        auto_confirmation_disabled: 'attention',
      },
      details: { credits_exhausted: { available: 480, debt: 0 } },
    });
  });

  it('passes filters, inclusive date ranges and a lookahead limit to SQL', async () => {
    const findStorePage = jest.fn().mockResolvedValue({ summary, rows: [] });
    const service = createService({ findStorePage });

    await service.getStores({
      search: 'shop',
      platform: 'standalone',
      health_status: 'critical',
      customer_country: 'gt',
      installed_from: '2026-09-01',
      installed_to: '2026-09-10',
      sort: 'health',
      direction: 'asc',
      limit: 10,
    });

    const [filter, page, derivation] = findStorePage.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
      AdminStoreDerivation,
    ];
    expect(filter).toMatchObject({
      search: 'shop',
      platform: 'standalone',
      healthStatus: 'critical',
      customerCountry: 'gt',
      installedFrom: '2026-09-01T00:00:00.000Z',
      installedTo: '2026-09-10T23:59:59.999Z',
    });
    expect(page).toEqual({
      sort: 'health',
      direction: 'asc',
      limit: 11,
      cursor: undefined,
    });
    expect(derivation.lowBalanceThreshold).toBe(10);
    expect(Object.keys(derivation.planLimits)).toEqual([
      'starter',
      'basic',
      'pro',
      'business',
    ]);
  });

  it('emits a keyset cursor that round-trips for the same sort', async () => {
    const findStorePage = jest.fn().mockResolvedValue({
      summary,
      rows: [
        shopifyRow({ sort_value: 'shopify store' }),
        standaloneRow({ sort_value: 'standalone org' }),
      ],
    });
    const service = createService({ findStorePage });

    const first = await service.getStores({ sort: 'store_name', limit: 1 });

    expect(first.data).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();

    await service.getStores({
      sort: 'store_name',
      limit: 1,
      cursor: first.next_cursor!,
    });
    const [, secondPage] = findStorePage.mock.calls[1] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(secondPage).toMatchObject({
      cursor: { value: 'shopify store', id: SHOPIFY_ID },
    });
  });

  it('rejects cursors from another sort or malformed cursors', async () => {
    const findStorePage = jest.fn().mockResolvedValue({
      summary,
      rows: [shopifyRow(), standaloneRow()],
    });
    const service = createService({ findStorePage });
    const { next_cursor } = await service.getStores({ limit: 1 });

    await expect(
      service.getStores({ cursor: next_cursor!, sort: 'health' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getStores({ cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findStorePage).toHaveBeenCalledTimes(1);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'exposes saved thank-you=%s and auto-cancellation=%s per store',
    async (acknowledgmentEnabled, autoCancelEnabled) => {
      const shopify = {
        ...detailRow(shopifyRow()),
        acknowledgment_enabled: acknowledgmentEnabled,
        auto_cancel_enabled: autoCancelEnabled,
      };
      const standalone = {
        ...detailRow(standaloneRow()),
        acknowledgment_enabled: !acknowledgmentEnabled,
        auto_cancel_enabled: !autoCancelEnabled,
      };
      const findStoreById = jest
        .fn()
        .mockImplementation((integrationId: string) =>
          Promise.resolve(integrationId === SHOPIFY_ID ? shopify : standalone),
        );
      const service = createService({
        findStoreById,
        findStoreVerificationTotals: jest.fn().mockResolvedValue([]),
      });
      const [first, second] = await Promise.all([
        service.getStore(SHOPIFY_ID),
        service.getStore(STANDALONE_ID),
      ]);
      expect(first.store.settings).toMatchObject({
        acknowledgment_enabled: acknowledgmentEnabled,
        auto_cancel_enabled: autoCancelEnabled,
      });
      expect(second.store.settings).toMatchObject({
        acknowledgment_enabled: !acknowledgmentEnabled,
        auto_cancel_enabled: !autoCancelEnabled,
      });
      expect(findStoreById).toHaveBeenCalledWith(
        SHOPIFY_ID,
        expect.any(Object),
      );
      expect(findStoreById).toHaveBeenCalledWith(
        STANDALONE_ID,
        expect.any(Object),
      );
    },
  );

  it('returns store details with verification totals and milestones', async () => {
    const service = createService({
      findStoreById: jest.fn().mockResolvedValue(detailRow(standaloneRow())),
      findStoreVerificationTotals: jest.fn().mockResolvedValue([
        { status: 'confirmed', is_test: false, count: 4, sent: 4 },
        { status: 'canceled', is_test: false, count: 1, sent: 1 },
        { status: 'sent', is_test: false, count: 3, sent: 3 },
        { status: 'failed', is_test: false, count: 2, sent: 0 },
        { status: 'confirmed', is_test: true, count: 2, sent: 2 },
      ]),
    });

    const { store } = await service.getStore(STANDALONE_ID);

    expect(store.owner_email).toBe('owner@example.com');
    expect(store.merchant_whatsapp_phone).toBe('+966500000001');
    expect(store.settings.follow_up_enabled).toBe(false);
    expect(store.verification_totals).toMatchObject({
      total: 10,
      test: 2,
      sent: 8,
      by_status: { confirmed: 4, canceled: 1, sent: 3, failed: 2 },
    });
    expect(
      store.milestones.find((item) => item.key === 'first_real_cod_resolved'),
    ).toEqual({ key: 'first_real_cod_resolved', at: recent, estimated: true });
  });

  it('describes each active signal with short, non-personal facts', async () => {
    const row = {
      ...shopifyRow(),
      critical_signals: ['orders_not_eligible', 'reinstalled_without_plan'],
      attention_signals: ['usage_attention', 'auto_confirmation_disabled'],
      health_status: 'critical',
      intake_received_24h: 13,
      intake_eligible_24h: 1,
      intake_skipped_24h: 12,
      intake_top_skip_reason: 'non_cod_payment_method',
      intake_top_payment_method: 'manual',
      previous_install_at: '2026-10-01T00:00:00.000Z',
      previous_uninstalled_at: '2026-11-11T10:00:00.000Z',
      previous_plan_id: 'pro',
      installed_at: '2026-11-11T10:07:00.000Z',
    };
    const findStorePage = jest.fn().mockResolvedValue({ summary, rows: [row] });
    const service = createService({ findStorePage });

    const result = await service.getStores({ signal: 'orders_not_eligible' });

    expect(findStorePage).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'orders_not_eligible' }),
      expect.any(Object),
      expect.any(Object),
    );
    const [store] = result.data;
    expect(store.health.top_signal).toBe('orders_not_eligible');
    expect(store.health.signals).toEqual([
      'orders_not_eligible',
      'reinstalled_without_plan',
      'usage_attention',
      'auto_confirmation_disabled',
    ]);
    expect(store.health.details).toEqual({
      orders_not_eligible: {
        received: 13,
        eligible: 1,
        skipped: 12,
        top_reason: 'non_cod_payment_method',
        top_payment_method: 'manual',
      },
      reinstalled_without_plan: {
        previous_plan: 'pro',
        lost_at: '2026-11-11T10:00:00.000Z',
        reinstalled_at: '2026-11-11T10:07:00.000Z',
      },
      usage_attention: { percent: 30, used: 30, limit: 100 },
    });
    expect(JSON.stringify(store.health.details)).not.toMatch(
      /phone|customer|email/i,
    );
  });

  it('passes the paid plans to the health rules', async () => {
    const findStorePage = jest.fn().mockResolvedValue({ summary, rows: [] });
    await createService({ findStorePage }).getStores({});

    expect(findStorePage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ paidPlanIds: ['basic', 'pro', 'business'] }),
    );
  });

  it('returns seven local days of order intake and the reinstall billing facts', async () => {
    const findStoreOrderIntake = jest.fn().mockResolvedValue({
      days: [{ day: '2026-11-10', received: 13, eligible: 0, skipped: 13 }],
      reasons: [{ key: 'non_cod_payment_method', count: 13 }],
      paymentMethods: [
        { key: 'manual', count: 13 },
        { key: 'Cash on Delivery (COD)', count: 4 },
      ],
    });
    const service = createService({
      findStoreById: jest.fn().mockResolvedValue(
        detailRow({
          ...shopifyRow(),
          timezone: 'Africa/Cairo',
          subscription_status: 'cancelled',
          previous_install_at: '2026-10-01T00:00:00.000Z',
          previous_uninstalled_at: '2026-11-11T10:00:00.000Z',
          previous_plan_id: 'pro',
        }),
      ),
      findStoreVerificationTotals: jest.fn().mockResolvedValue([]),
      findStoreOrderIntake,
    });

    const { store } = await service.getStore(SHOPIFY_ID);

    expect(findStoreOrderIntake).toHaveBeenCalledWith(
      SHOPIFY_ID,
      'Africa/Cairo',
      7,
    );
    expect(store.order_intake.days).toHaveLength(7);
    expect(store.order_intake.time_zone).toBe('Africa/Cairo');
    expect(store.order_intake.skip_reasons).toEqual([
      { reason: 'non_cod_payment_method', count: 13 },
    ]);
    expect(store.order_intake.payment_methods[0]).toEqual({
      name: 'manual',
      count: 13,
    });
    expect(store.reinstall).toEqual({
      previous_plan: 'pro',
      lost_at: '2026-11-11T10:00:00.000Z',
      reinstalled_at: shopifyRow().installed_at,
      has_active_plan: false,
    });
  });

  it('counts intake days in the store time zone and fills quiet days', () => {
    const view = toOrderIntakeView(
      {
        days: [
          { day: '2026-11-06', received: 3, eligible: 3, skipped: 0 },
          { day: '2026-11-12', received: '5', eligible: '1', skipped: '4' },
        ],
        reasons: [],
        paymentMethods: [],
      },
      'Africa/Cairo',
      // 23:30 UTC is already the 13th in Cairo.
      new Date('2026-11-12T23:30:00.000Z'),
    );

    expect(view.days.map((day) => day.day)).toEqual([
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
    ]);
    expect(view.days[5]).toEqual({
      day: '2026-11-12',
      received: 5,
      eligible: 1,
      skipped: 4,
    });
  });

  it('falls back to UTC for a missing or unknown time zone', () => {
    expect(validTimeZone(null)).toBe('UTC');
    expect(validTimeZone('Not/AZone')).toBe('UTC');
    expect(validTimeZone("UTC'; DROP")).toBe('UTC');
    expect(validTimeZone('America/Argentina/Buenos_Aires')).toBe(
      'America/Argentina/Buenos_Aires',
    );
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
      customer_country: 'SA',
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
    expect(result.data[0].customer_country).toBe('SA');
    expect(JSON.stringify(result)).not.toContain('+966512345123');
  });

  it('reports the provider error of a failed verification only', async () => {
    const metadata = {
      reason: 'provider_delivery_failed',
      providerErrorCode: 131026,
      providerErrorTitle: 'Message undeliverable',
    };
    const row = (id: string, status: string) => ({
      id,
      status,
      metadata,
      customer_phone: '+966512345123',
      created_at: '2026-09-01T00:00:00Z',
    });
    const service = createService({
      findStoreById: jest.fn().mockResolvedValue(detailRow(shopifyRow())),
      findStoreVerifications: jest.fn().mockResolvedValue({
        rows: [row('v-2', 'failed'), row('v-1', 'confirmed')],
        totalCount: 2,
      }),
    });

    const { data } = await service.getStoreVerifications('store', {});

    expect(data[0]).toMatchObject({
      reason: 'provider_delivery_failed',
      failure_code: '131026',
      failure_title: 'Message undeliverable',
    });
    expect(data[1]).toMatchObject({ failure_code: null, failure_title: null });
  });

  it('offers a resend only for an unresolved verification', async () => {
    const row = (id: string, status: string) => ({
      id,
      status,
      metadata: { reason: 'provider_outcome_unknown' },
      customer_phone: '+966512345123',
      created_at: '2026-09-01T00:00:00Z',
      resend_dispatch_id: `dispatch-${id}`,
    });
    const service = createService({
      findStoreById: jest.fn().mockResolvedValue(detailRow(shopifyRow())),
      findStoreVerifications: jest.fn().mockResolvedValue({
        rows: [row('v-2', 'failed'), row('v-1', 'confirmed')],
        totalCount: 2,
      }),
    });

    const { data } = await service.getStoreVerifications('store', {});

    expect(data[0].resend_dispatch_id).toBe('dispatch-v-2');
    // A customer reply is final, so there is nothing to resend.
    expect(data[1].resend_dispatch_id).toBeNull();
  });
});
