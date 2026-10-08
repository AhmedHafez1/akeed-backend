import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WhatsappTemplatesRepository,
  type InspectedTemplate,
} from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import { WhatsappTemplateSyncRepository } from '../../infrastructure/database/repositories/whatsapp-template-sync.repository';
import {
  isWhatsappTemplateOperator,
  readWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import {
  renderRegisteredPreview,
  renderTemplateMessage,
} from '../../shared/messaging/template-rendering';
import {
  hasSyncedRegistry,
  isSendableTemplate,
} from '../../shared/messaging/template-selector';
import {
  TEMPLATE_CATALOG_PORT,
  type TemplateCatalogPort,
} from '../../shared/ports/template-catalog.port';
import { TemplateMessageService } from '../template-registry/template-message.service';
import { WhatsappTemplateSyncService } from '../template-registry/whatsapp-template-sync.service';
import {
  AdminQueryRepository,
  type AdminTemplateMetricsFilter,
} from './admin-query.repository';
import {
  resolveTemplateMetricsRange,
  TEMPLATE_METRICS_MAX_RANGE_DAYS,
  type TemplateMetricsRangeProblem,
} from './admin-template-metrics.policy';
import {
  driftOf,
  toDriftDetail,
  toEventRows,
  toPurposeMetricsView,
  toStoreRows,
  toSyncRunRows,
  toTemplateSummary,
  toVariableRows,
  variantKeyOf,
  type AdminTemplateContext,
  type AdminTemplateDetailResponse,
  type AdminTemplateListResponse,
} from './admin-template-view';
import { toSyncRunView } from './admin-templates.service';
import type { AdminTemplateMetricsQueryDto } from './dto/admin-query.dto';
import { WHATSAPP_TEMPLATE_ERROR_CODES } from './whatsapp-template-operator.guard';

/** A registry key: `<purpose>.<language>.<style>`, lowercase. */
const TEMPLATE_KEY = /^[a-z0-9_]{1,40}(\.[a-z0-9_]{1,40}){2}$/;

const HISTORY_EVENT_LIMIT = 50;
const HISTORY_RUN_LIMIT = 20;
const STORE_LIMIT = 100;

const RANGE_MESSAGES: Record<TemplateMetricsRangeProblem, string> = {
  invalid_date: 'from and to must be calendar dates written as YYYY-MM-DD.',
  from_after_to: 'from must not be later than to.',
  range_too_long: `The range may cover at most ${TEMPLATE_METRICS_MAX_RANGE_DAYS} days.`,
};

export function templateNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    message: 'No WhatsApp template has this key.',
    code: WHATSAPP_TEMPLATE_ERROR_CODES.notFound,
  });
}

/**
 * What staff see about the template registry (US-08-05): each template, what
 * the provider says about it, who sends it and how it performed. Read-only,
 * and not scoped to a tenant.
 */
@Injectable()
export class AdminTemplateInspectionService {
  constructor(
    private readonly templates: WhatsappTemplatesRepository,
    private readonly syncRepository: WhatsappTemplateSyncRepository,
    private readonly metrics: AdminQueryRepository,
    private readonly sync: WhatsappTemplateSyncService,
    @Inject(TEMPLATE_CATALOG_PORT)
    private readonly catalog: TemplateCatalogPort,
    private readonly config: ConfigService,
    private readonly messages: TemplateMessageService,
  ) {}

  async list(
    userId: string,
    query: AdminTemplateMetricsQueryDto,
  ): Promise<AdminTemplateListResponse> {
    const filter = this.metricsFilter(query);
    const [inspected, metricRows, [lastRun]] = await Promise.all([
      this.templates.findAllForInspection(),
      this.metrics.findTemplateMetrics(filter),
      this.sync.recentRuns(1),
    ]);
    const storeCounts = await this.syncRepository.activeStoreCountsByKey(
      inspected.map(({ template }) => template.key),
    );
    const guardrailOn = hasSyncedRegistry(
      inspected.map(({ template }) => template),
    );

    return {
      ...this.context(userId, query, lastRun),
      templates: inspected.map((entry) =>
        toTemplateSummary({
          inspected: entry,
          drift: driftOf(
            entry,
            this.catalog.describeComponents(entry.components),
            this.messages.linesFor(entry.template).source,
          ),
          sendable: isSendableTemplate(entry.template, guardrailOn),
          activeStoreCount: storeCounts.get(entry.template.key) ?? 0,
          metrics: metricRows.find(
            (row) => row.variant_key === variantKeyOf(entry.template),
          ),
        }),
      ),
    };
  }

  async detail(
    userId: string,
    key: string,
    query: AdminTemplateMetricsQueryDto,
  ): Promise<AdminTemplateDetailResponse> {
    const filter = this.metricsFilter(query);
    const entry = await this.find(key);
    const { template } = entry;
    const variantKey = variantKeyOf(template);
    const [all, metricRows, byPurpose, runs, events, stores] =
      await Promise.all([
        this.templates.findAllForInspection(),
        this.metrics.findTemplateMetrics(filter),
        this.metrics.findTemplateMetricsByPurpose(filter, variantKey),
        this.sync.recentRuns(HISTORY_RUN_LIMIT),
        this.syncRepository.eventsForTemplate(entry.id, HISTORY_EVENT_LIMIT),
        this.syncRepository.activeStoresUsingKey(template.key, STORE_LIMIT),
      ]);
    const model = this.catalog.describeComponents(entry.components);
    const drift = driftOf(
      entry,
      model,
      this.messages.linesFor(template).source,
    );
    const runViews = runs.map(toSyncRunView);

    return {
      ...this.context(userId, query, runs[0]),
      template: {
        ...toTemplateSummary({
          inspected: entry,
          drift,
          sendable: isSendableTemplate(
            template,
            hasSyncedRegistry(all.map((row) => row.template)),
          ),
          activeStoreCount: stores.total,
          metrics: metricRows.find((row) => row.variant_key === variantKey),
        }),
        provider_template_id: entry.providerTemplateId,
        text_changed_at: entry.componentsDriftAt,
      },
      message: model ? renderTemplateMessage(model, template) : null,
      registered_preview: renderRegisteredPreview(template),
      variables: toVariableRows(template),
      drift: toDriftDetail(drift),
      history: {
        events: toEventRows(events),
        sync_runs: toSyncRunRows(runViews, template.key),
      },
      stores: { total: stores.total, shown: toStoreRows(stores.stores) },
      metrics_by_purpose: byPurpose.map(toPurposeMetricsView),
    };
  }

  /** The template with this key, or a coded 404. */
  async find(key: string): Promise<InspectedTemplate> {
    const entry = TEMPLATE_KEY.test(key)
      ? await this.templates.findForInspection(key)
      : undefined;
    if (!entry) throw templateNotFound();
    return entry;
  }

  private context(
    userId: string,
    query: AdminTemplateMetricsQueryDto,
    lastRun: Parameters<typeof toSyncRunView>[0] | undefined,
  ): AdminTemplateContext {
    const config = readWhatsappTemplateConfig(this.config);
    const operator = isWhatsappTemplateOperator(config, userId);
    return {
      range: { from: query.from, to: query.to, timezone: 'UTC' },
      sync: {
        enabled: config.syncEnabled,
        guardrail_enabled: config.guardrailEnabled,
        last_run: lastRun ? toSyncRunView(lastRun) : null,
      },
      operations: {
        enabled: config.operationsEnabled,
        operator,
        test_send_available: operator && config.testPhones.size > 0,
      },
      evaluated_at: new Date().toISOString(),
    };
  }

  /** Real sends only: a merchant's test is not how a template performed. */
  private metricsFilter(
    query: AdminTemplateMetricsQueryDto,
  ): AdminTemplateMetricsFilter {
    const range = resolveTemplateMetricsRange(query.from, query.to);
    if (!range.ok) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: RANGE_MESSAGES[range.problem],
        code: 'ADMIN_TEMPLATE_METRICS_RANGE_INVALID',
      });
    }
    return {
      from: range.from,
      toExclusive: range.toExclusive,
      includeTest: query.include_test === true,
    };
  }
}
