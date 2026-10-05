import type { InspectedTemplate } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import type {
  TemplateEventRecord,
  TemplateStoreUse,
} from '../../infrastructure/database/repositories/whatsapp-template-sync.repository';
import {
  compareTemplateDrift,
  type TemplateDrift,
  type TemplateDriftDifference,
  type TemplateDriftKind,
  type TemplateDriftSeverity,
  type TemplateDriftState,
} from '../../shared/messaging/template-drift';
import type {
  TemplateCategory,
  TemplateQuality,
  TemplateReviewStatus,
} from '../../shared/messaging/template-provider.types';
import type {
  TemplateLanguage,
  TemplateParameterFormat,
  TemplatePurpose,
  TemplateVariableKey,
} from '../../shared/messaging/template-registry.types';
import {
  providerParameterOf,
  templateSampleValues,
} from '../../shared/messaging/template-rendering';
import type {
  RenderedTemplateMessage,
  TemplateTextModel,
} from '../../shared/messaging/template-text.types';
import type {
  AdminTemplateMetricsRow,
  AdminTemplatePurposeMetricsRow,
} from './admin-query.repository';
import type { AdminTemplateSyncRunView } from './admin-templates.service';

/**
 * What became of a template's sends in the range. Rates are shares of the
 * sends WhatsApp accepted, from 0 to 1, and null when there were none.
 */
export interface AdminTemplateMetricsView {
  sends: number;
  delivered: number;
  read: number;
  replies: number;
  confirmed: number;
  canceled: number;
  no_reply: number;
  reply_rate: number | null;
  confirmation_rate: number | null;
}

export interface AdminTemplatePurposeMetricsView extends AdminTemplateMetricsView {
  purpose: string;
}

export interface AdminTemplateDriftSummary {
  state: TemplateDriftState;
  kinds: TemplateDriftKind[];
  /** The worst difference found; null when there is none. */
  severity: TemplateDriftSeverity | null;
}

export interface AdminTemplateSummary {
  key: string;
  purpose: TemplatePurpose;
  language: TemplateLanguage;
  style: string;
  template_name: string;
  language_code: string;
  parameter_format: TemplateParameterFormat;
  review_status: TemplateReviewStatus | null;
  category: TemplateCategory | null;
  pending_category: TemplateCategory | null;
  quality: TemplateQuality | null;
  is_active: boolean;
  is_default: boolean;
  /** Active and, once this environment has synced, approved. */
  sendable: boolean;
  last_synced_at: string | null;
  active_store_count: number;
  drift: AdminTemplateDriftSummary;
  metrics: AdminTemplateMetricsView;
}

export interface AdminTemplateContext {
  range: { from: string; to: string; timezone: 'UTC' };
  sync: {
    enabled: boolean;
    guardrail_enabled: boolean;
    last_run: AdminTemplateSyncRunView | null;
  };
  operations: {
    enabled: boolean;
    /** Whether the staff member asking is a named template operator. */
    operator: boolean;
    test_send_available: boolean;
  };
  evaluated_at: string;
}

export interface AdminTemplateListResponse extends AdminTemplateContext {
  templates: AdminTemplateSummary[];
}

export interface AdminTemplateDetailResponse extends AdminTemplateContext {
  template: AdminTemplateSummary & {
    provider_template_id: string | null;
    text_changed_at: string | null;
  };
  /** The provider's text with sample values; null when it has none to show. */
  message: RenderedTemplateMessage | null;
  /** The hand-kept preview merchants see, with the same sample values. */
  registered_preview: RenderedTemplateMessage;
  variables: {
    variable: TemplateVariableKey;
    /** The provider's parameter name, or its position from 1. */
    parameter: string;
    sample: string;
  }[];
  drift: AdminTemplateDriftSummary & {
    differences: TemplateDriftDifference[];
  };
  history: {
    events: {
      id: string;
      field: string;
      value: Record<string, string | null>;
      outcome: string;
      occurred_at: string;
      received_at: string;
    }[];
    sync_runs: (Pick<
      AdminTemplateSyncRunView,
      'id' | 'trigger' | 'status' | 'started_at' | 'finished_at' | 'error_code'
    > & { missing: boolean })[];
  };
  stores: {
    total: number;
    shown: {
      integration_id: string;
      store_name: string | null;
      platform: string;
      /** Null for a Standalone source, whose address is an internal identity. */
      domain: string | null;
      default_language: string;
    }[];
  };
  metrics_by_purpose: AdminTemplatePurposeMetricsView[];
}

type MetricCountsRow = Pick<
  AdminTemplateMetricsRow,
  'sends' | 'delivered' | 'read' | 'confirmed' | 'canceled' | 'no_reply'
>;

function rate(part: number, sends: number): number | null {
  return sends > 0 ? Math.round((part / sends) * 10_000) / 10_000 : null;
}

export function toMetricsView(
  row: MetricCountsRow | undefined,
): AdminTemplateMetricsView {
  const sends = Number(row?.sends ?? 0);
  const confirmed = Number(row?.confirmed ?? 0);
  const canceled = Number(row?.canceled ?? 0);
  const replies = confirmed + canceled;
  return {
    sends,
    delivered: Number(row?.delivered ?? 0),
    read: Number(row?.read ?? 0),
    replies,
    confirmed,
    canceled,
    no_reply: Number(row?.no_reply ?? 0),
    reply_rate: rate(replies, sends),
    confirmation_rate: rate(confirmed, sends),
  };
}

export function toPurposeMetricsView(
  row: AdminTemplatePurposeMetricsRow,
): AdminTemplatePurposeMetricsView {
  return { purpose: row.purpose, ...toMetricsView(row) };
}

/** The variant key sends record for a registry template (US-08-02). */
export function variantKeyOf(
  template: Pick<InspectedTemplate['template'], 'language' | 'style'>,
): string {
  return `${template.language}.${template.style}`;
}

function summarizeDrift(drift: TemplateDrift): AdminTemplateDriftSummary {
  return {
    state: drift.state,
    kinds: drift.differences.map((difference) => difference.kind),
    severity: drift.differences.some(
      (difference) => difference.severity === 'send',
    )
      ? 'send'
      : drift.differences.length > 0
        ? 'preview'
        : null,
  };
}

export function driftOf(
  inspected: InspectedTemplate,
  model: TemplateTextModel | null,
): TemplateDrift {
  return compareTemplateDrift({
    template: inspected.template,
    reviewStatus: inspected.template.reviewStatus,
    model,
  });
}

export function toTemplateSummary(params: {
  inspected: InspectedTemplate;
  drift: TemplateDrift;
  sendable: boolean;
  activeStoreCount: number;
  metrics: MetricCountsRow | undefined;
}): AdminTemplateSummary {
  const { inspected } = params;
  const { template } = inspected;
  return {
    key: template.key,
    purpose: template.purpose,
    language: template.language,
    style: template.style,
    template_name: template.templateName,
    language_code: template.languageCode,
    parameter_format: template.parameterFormat,
    review_status: template.reviewStatus,
    category: template.category,
    pending_category: inspected.pendingCategory,
    quality: inspected.quality,
    is_active: template.isActive,
    is_default: template.isDefault,
    sendable: params.sendable,
    last_synced_at: template.lastSyncedAt,
    active_store_count: params.activeStoreCount,
    drift: summarizeDrift(params.drift),
    metrics: toMetricsView(params.metrics),
  };
}

export function toDriftDetail(
  drift: TemplateDrift,
): AdminTemplateDetailResponse['drift'] {
  return { ...summarizeDrift(drift), differences: drift.differences };
}

export function toVariableRows(
  template: InspectedTemplate['template'],
): AdminTemplateDetailResponse['variables'] {
  const samples = templateSampleValues(template.language);
  return template.variables.map((variable, index) => ({
    variable: variable.key,
    parameter: providerParameterOf(template, index),
    sample: samples[variable.key],
  }));
}

export function toEventRows(
  events: readonly TemplateEventRecord[],
): AdminTemplateDetailResponse['history']['events'] {
  return events.map((event) => ({
    id: event.id,
    field: event.field,
    value: event.neutralValue,
    outcome: event.outcome,
    occurred_at: event.occurredAt,
    received_at: event.receivedAt,
  }));
}

export function toSyncRunRows(
  runs: readonly AdminTemplateSyncRunView[],
  key: string,
): AdminTemplateDetailResponse['history']['sync_runs'] {
  return runs.map((run) => ({
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    error_code: run.error_code,
    missing: run.missing_keys.includes(key),
  }));
}

export function toStoreRows(
  stores: readonly TemplateStoreUse[],
): AdminTemplateDetailResponse['stores']['shown'] {
  return stores.map((store) => ({
    integration_id: store.integrationId,
    store_name: store.storeName,
    platform: store.platformType,
    domain: store.platformType === 'standalone' ? null : store.storeUrl,
    default_language: store.defaultLanguage,
  }));
}
