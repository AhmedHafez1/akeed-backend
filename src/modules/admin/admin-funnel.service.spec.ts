import { AdminFunnelService } from './admin-funnel.service';
import type { AdminStoreQueryRow } from './admin-query.repository';

function row(overrides: Partial<AdminStoreQueryRow> = {}): AdminStoreQueryRow {
  return {
    integration_id: 'int-1',
    organization_name: 'Example',
    store_name: 'Example',
    shop_domain: 'example.myshopify.com',
    country_code: 'EG',
    timezone: 'Africa/Cairo',
    is_active: true,
    onboarding_status: 'completed',
    plan: 'basic',
    subscription_status: 'active',
    auto_confirmation_enabled: true,
    installed_at: '2026-08-01T00:00:00Z',
    uninstalled_at: null,
    onboarding_started_at: '2026-08-01T00:30:00Z',
    onboarding_completed_at: '2026-08-01T01:00:00Z',
    plan_selected_at: '2026-08-01T02:00:00Z',
    test_requested_at: '2026-08-01T03:00:00Z',
    test_delivered_at: '2026-08-01T03:05:00Z',
    first_eligible_order_at: '2026-08-02T00:00:00Z',
    first_message_delivered_at: '2026-08-02T00:05:00Z',
    first_customer_response_at: '2026-08-02T00:10:00Z',
    first_resolved_at: '2026-08-02T00:10:00Z',
    paid_subscription_activated_at: '2026-08-01T02:30:00Z',
    provenance: {},
    usage_used: 10,
    usage_limit: 300,
    last_activity_at: '2026-08-02T00:10:00Z',
    failed_24h: 0,
    total_24h: 1,
    failed_webhooks_1h: 0,
    ...overrides,
  };
}

describe('AdminFunnelService', () => {
  it('calculates cohort, step conversion, day-seven, and uninstall separately', async () => {
    const repository = {
      findStores: jest.fn().mockResolvedValue([
        row(),
        row({
          integration_id: 'int-2',
          onboarding_completed_at: null,
          plan_selected_at: null,
          test_requested_at: null,
          test_delivered_at: null,
          first_eligible_order_at: null,
          first_message_delivered_at: null,
          first_customer_response_at: null,
          first_resolved_at: null,
          paid_subscription_activated_at: null,
          uninstalled_at: '2026-08-05T00:00:00Z',
        }),
      ]),
    };
    const service = new AdminFunnelService(repository as never);

    const result = await service.getFunnel({ country: 'EG' });

    expect(result.cohort.installed_count).toBe(2);
    expect(result.stages[1]).toMatchObject({
      stage: 'onboarding_completed',
      reached: 1,
      overall_rate: 50,
      step_rate: 50,
    });
    expect(result.active_after_7_days).toMatchObject({
      eligible_installations: 2,
      reached: 1,
      rate: 50,
    });
    expect(result.uninstall).toMatchObject({ count: 1, rate: 50 });
  });
});
