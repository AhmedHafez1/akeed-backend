import { Injectable } from '@nestjs/common';
import {
  AdminQueryRepository,
  type AdminStoreQueryRow,
} from './admin-query.repository';
import type { AdminFunnelQueryDto } from './dto/admin-query.dto';

interface FunnelStageDefinition {
  stage: string;
  value: (row: AdminStoreQueryRow) => string | null;
}

const STAGES: FunnelStageDefinition[] = [
  { stage: 'installation_completed', value: (row) => row.installed_at },
  {
    stage: 'onboarding_completed',
    value: (row) => row.onboarding_completed_at,
  },
  { stage: 'plan_selected', value: (row) => row.plan_selected_at },
  { stage: 'test_requested', value: (row) => row.test_requested_at },
  { stage: 'test_delivered', value: (row) => row.test_delivered_at },
  {
    stage: 'eligible_real_cod_detected',
    value: (row) => row.first_eligible_order_at,
  },
  {
    stage: 'first_confirmation_delivered',
    value: (row) => row.first_message_delivered_at,
  },
  {
    stage: 'first_customer_response',
    value: (row) => row.first_customer_response_at,
  },
  { stage: 'first_real_cod_resolved', value: (row) => row.first_resolved_at },
  {
    stage: 'paid_subscription_activated',
    value: (row) => row.paid_subscription_activated_at,
  },
];

@Injectable()
export class AdminFunnelService {
  constructor(private readonly repository: AdminQueryRepository) {}

  async getFunnel(query: AdminFunnelQueryDto) {
    const now = new Date();
    const allRows = await this.repository.findStores();
    const rows = allRows.filter((row) => this.matches(row, query));
    const installedCount = rows.length;
    const stages = STAGES.map((definition, index) => {
      const reachedRows = rows.filter((row) => definition.value(row));
      const previous = STAGES[index - 1];
      const previousReached = previous
        ? rows.filter((row) => previous.value(row)).length
        : installedCount;
      const durations = previous
        ? reachedRows.flatMap((row) => {
            const start = previous.value(row);
            const end = definition.value(row);
            if (!start || !end) return [];
            return [Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000)];
          })
        : [];
      const quality = reachedRows.map((row) =>
        this.captureFor(row, definition.stage),
      );
      const exact = quality.filter((capture) => capture === 'exact').length;
      const estimated = quality.filter(
        (capture) => capture === 'estimated',
      ).length;

      return {
        stage: definition.stage,
        reached: reachedRows.length,
        overall_rate: this.rate(reachedRows.length, installedCount),
        step_rate: this.rate(reachedRows.length, previousReached),
        average_time_from_previous_seconds:
          durations.length > 0
            ? Math.round(
                durations.reduce((total, duration) => total + duration, 0) /
                  durations.length,
              )
            : null,
        time_sample_size: durations.length,
        capture:
          estimated > 0 && exact > 0
            ? 'mixed'
            : estimated > 0
              ? 'estimated'
              : exact > 0
                ? 'exact'
                : 'unavailable',
        coverage_percent: this.rate(reachedRows.length, installedCount),
      };
    });

    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const eligible = rows.filter(
      (row) => now.getTime() - Date.parse(row.installed_at) >= sevenDays,
    );
    const activeAfterSeven = eligible.filter((row) => {
      if (!row.first_resolved_at) return false;
      const daySeven = Date.parse(row.installed_at) + sevenDays;
      return (
        Date.parse(row.first_resolved_at) <= daySeven &&
        (!row.uninstalled_at || Date.parse(row.uninstalled_at) > daySeven)
      );
    });
    const uninstalled = rows.filter((row) => row.uninstalled_at);
    const uninstallDurations = uninstalled.map(
      (row) =>
        (Date.parse(row.uninstalled_at!) - Date.parse(row.installed_at)) / 1000,
    );
    const qualityCounts = this.qualityCounts(rows);

    return {
      cohort: {
        installed_from: query.installed_from ?? null,
        installed_to: query.installed_to ?? null,
        installed_count: installedCount,
      },
      stages,
      active_after_7_days: {
        eligible_installations: eligible.length,
        reached: activeAfterSeven.length,
        rate: this.rate(activeAfterSeven.length, eligible.length),
      },
      uninstall: {
        count: uninstalled.length,
        rate: this.rate(uninstalled.length, installedCount),
        average_time_from_install_seconds:
          uninstallDurations.length > 0
            ? Math.round(
                uninstallDurations.reduce((total, value) => total + value, 0) /
                  uninstallDurations.length,
              )
            : null,
      },
      data_quality: {
        ...qualityCounts,
        notes:
          qualityCounts.estimated > 0
            ? [
                'Some historical milestones were inferred from retained records.',
              ]
            : [],
      },
      evaluated_at: now.toISOString(),
    };
  }

  private matches(
    row: AdminStoreQueryRow,
    query: AdminFunnelQueryDto,
  ): boolean {
    const installed = Date.parse(row.installed_at);
    if (query.installed_from && installed < Date.parse(query.installed_from))
      return false;
    if (query.installed_to) {
      const end =
        Date.parse(query.installed_to) +
        (/^\d{4}-\d{2}-\d{2}$/.test(query.installed_to) ? 86_399_999 : 0);
      if (installed > end) return false;
    }
    if (query.plan && row.plan !== query.plan) return false;
    if (
      query.country &&
      (row.country_code ?? '').toUpperCase() !== query.country.toUpperCase()
    )
      return false;
    return true;
  }

  private captureFor(row: AdminStoreQueryRow, stage: string) {
    const provenance = row.provenance ?? {};
    const value = provenance[stage];
    return String(value ?? '').startsWith('estimated') ? 'estimated' : 'exact';
  }

  private qualityCounts(rows: AdminStoreQueryRow[]) {
    let exact = 0;
    let estimated = 0;
    let unavailable = 0;
    for (const row of rows) {
      for (const definition of STAGES) {
        if (!definition.value(row)) unavailable += 1;
        else if (this.captureFor(row, definition.stage) === 'estimated')
          estimated += 1;
        else exact += 1;
      }
    }
    const total = exact + estimated + unavailable;
    if (total === 0) return { exact: 0, estimated: 0, unavailable: 0 };
    return {
      exact: this.rate(exact, total),
      estimated: this.rate(estimated, total),
      unavailable: this.rate(unavailable, total),
    };
  }

  private rate(numerator: number, denominator: number): number {
    return denominator > 0
      ? Math.round((numerator / denominator) * 10_000) / 100
      : 0;
  }
}
