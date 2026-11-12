import type { AdminStoreViewRow } from './admin-query.repository';

/**
 * Short facts behind each active health signal, so the dashboard can say what
 * happened and not only which rule fired. Counts, plan ids, skip codes,
 * payment-method names and times only: never customer data.
 */
export interface AdminSignalDetails {
  orders_not_eligible?: {
    received: number;
    eligible: number;
    skipped: number;
    top_reason: string | null;
    top_payment_method: string | null;
  };
  paid_store_uninstalled?: {
    plan: string | null;
    uninstalled_at: string | null;
    paid_through_at: string | null;
  };
  store_uninstalled?: { uninstalled_at: string | null };
  reinstalled_without_plan?: {
    previous_plan: string | null;
    lost_at: string | null;
    reinstalled_at: string | null;
  };
  subscription_blocked?: { status: string | null };
  usage_critical?: AdminUsageDetail;
  usage_attention?: AdminUsageDetail;
  failed_verification_rate?: { failed: number; total: number };
  webhook_failures?: { count: number };
  credits_exhausted?: AdminCreditDetail;
  credits_low?: AdminCreditDetail;
  onboarding_incomplete?: { since: string | null };
  no_eligible_order?: { since: string | null };
  no_recent_activity?: { since: string | null };
}

interface AdminUsageDetail {
  percent: number;
  used: number;
  limit: number;
}

interface AdminCreditDetail {
  available: number;
  debt: number;
}

export function buildSignalDetails(
  row: AdminStoreViewRow,
  signals: readonly string[],
): AdminSignalDetails {
  const active = new Set(signals);
  const details: AdminSignalDetails = {};
  const usage = (): AdminUsageDetail => ({
    percent: Number(row.usage_percent ?? 0),
    used: Number(row.usage_used ?? 0),
    limit: Number(row.usage_limit_effective ?? 0),
  });
  const credits = (): AdminCreditDetail => ({
    available: Number(row.credit_available ?? 0),
    debt: Number(row.credit_debt ?? 0),
  });

  if (active.has('orders_not_eligible'))
    details.orders_not_eligible = {
      received: Number(row.intake_received_24h ?? 0),
      eligible: Number(row.intake_eligible_24h ?? 0),
      skipped: Number(row.intake_skipped_24h ?? 0),
      top_reason: row.intake_top_skip_reason ?? null,
      top_payment_method: row.intake_top_payment_method ?? null,
    };
  if (active.has('paid_store_uninstalled'))
    details.paid_store_uninstalled = {
      plan: row.uninstall_plan_id ?? null,
      uninstalled_at: row.uninstalled_at,
      paid_through_at: row.uninstall_paid_through_at ?? null,
    };
  if (active.has('store_uninstalled'))
    details.store_uninstalled = { uninstalled_at: row.uninstalled_at };
  if (active.has('reinstalled_without_plan'))
    details.reinstalled_without_plan = {
      previous_plan: row.previous_plan_id ?? null,
      lost_at: row.previous_uninstalled_at ?? null,
      reinstalled_at: row.previous_install_at ? row.installed_at : null,
    };
  if (active.has('subscription_blocked'))
    details.subscription_blocked = { status: row.subscription_status };
  if (active.has('usage_critical')) details.usage_critical = usage();
  if (active.has('usage_attention')) details.usage_attention = usage();
  if (active.has('failed_verification_rate'))
    details.failed_verification_rate = {
      failed: Number(row.failed_24h ?? 0),
      total: Number(row.total_24h ?? 0),
    };
  if (active.has('webhook_failures'))
    details.webhook_failures = { count: Number(row.failed_webhooks_1h ?? 0) };
  if (active.has('credits_exhausted')) details.credits_exhausted = credits();
  if (active.has('credits_low')) details.credits_low = credits();
  if (active.has('onboarding_incomplete'))
    details.onboarding_incomplete = { since: row.installed_at };
  if (active.has('no_eligible_order'))
    details.no_eligible_order = { since: row.onboarding_completed_at };
  if (active.has('no_recent_activity'))
    details.no_recent_activity = { since: row.last_activity_at };
  return details;
}
