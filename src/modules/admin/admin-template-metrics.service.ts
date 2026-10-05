import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AdminQueryRepository,
  type AdminTemplateMetricsRow,
} from './admin-query.repository';
import {
  resolveTemplateMetricsRange,
  TEMPLATE_METRICS_MAX_RANGE_DAYS,
  type TemplateMetricsRangeProblem,
} from './admin-template-metrics.policy';
import type { AdminTemplateMetricsQueryDto } from './dto/admin-query.dto';

export interface AdminTemplateMetricCounts {
  /** Dispatches WhatsApp accepted, in total and by what the send was for. */
  sends: { total: number; initial: number; reminder: number; test: number };
  delivered: number;
  read: number;
  /** Customer confirmations plus customer cancellations. */
  replies: number;
  confirmed: number;
  canceled: number;
  no_reply: number;
}

export interface AdminTemplateMetric extends AdminTemplateMetricCounts {
  variant_key: string;
  template_name: string | null;
  language: string | null;
  language_code: string | null;
}

export interface AdminTemplateMetricsResponse {
  range: { from: string; to: string; timezone: 'UTC' };
  include_test: boolean;
  templates: AdminTemplateMetric[];
  /** Sends accepted before the template of a send was recorded. */
  not_recorded: AdminTemplateMetricCounts;
  evaluated_at: string;
}

const RANGE_MESSAGES: Record<TemplateMetricsRangeProblem, string> = {
  invalid_date: 'from and to must be calendar dates written as YYYY-MM-DD.',
  from_after_to: 'from must not be later than to.',
  range_too_long: `The range may cover at most ${TEMPLATE_METRICS_MAX_RANGE_DAYS} days.`,
};

function emptyCounts(): AdminTemplateMetricCounts {
  return {
    sends: { total: 0, initial: 0, reminder: 0, test: 0 },
    delivered: 0,
    read: 0,
    replies: 0,
    confirmed: 0,
    canceled: 0,
    no_reply: 0,
  };
}

function countsOf(row: AdminTemplateMetricsRow): AdminTemplateMetricCounts {
  const confirmed = Number(row.confirmed);
  const canceled = Number(row.canceled);
  return {
    sends: {
      total: Number(row.sends),
      initial: Number(row.sends_initial),
      reminder: Number(row.sends_reminder),
      test: Number(row.sends_test),
    },
    delivered: Number(row.delivered),
    read: Number(row.read),
    replies: confirmed + canceled,
    confirmed,
    canceled,
    no_reply: Number(row.no_reply),
  };
}

function add(
  total: AdminTemplateMetricCounts,
  counts: AdminTemplateMetricCounts,
): AdminTemplateMetricCounts {
  return {
    sends: {
      total: total.sends.total + counts.sends.total,
      initial: total.sends.initial + counts.sends.initial,
      reminder: total.sends.reminder + counts.sends.reminder,
      test: total.sends.test + counts.sends.test,
    },
    delivered: total.delivered + counts.delivered,
    read: total.read + counts.read,
    replies: total.replies + counts.replies,
    confirmed: total.confirmed + counts.confirmed,
    canceled: total.canceled + counts.canceled,
    no_reply: total.no_reply + counts.no_reply,
  };
}

/**
 * How each template performed over a range of sends, across every store and
 * source. Staff-only: the numbers are not scoped to a tenant.
 */
@Injectable()
export class AdminTemplateMetricsService {
  constructor(private readonly repository: AdminQueryRepository) {}

  async getMetrics(
    query: AdminTemplateMetricsQueryDto,
  ): Promise<AdminTemplateMetricsResponse> {
    const range = resolveTemplateMetricsRange(query.from, query.to);
    if (!range.ok) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: RANGE_MESSAGES[range.problem],
        code: 'ADMIN_TEMPLATE_METRICS_RANGE_INVALID',
      });
    }
    const includeTest = query.include_test === true;
    const rows = await this.repository.findTemplateMetrics({
      from: range.from,
      toExclusive: range.toExclusive,
      includeTest,
    });

    const templates: AdminTemplateMetric[] = [];
    let notRecorded = emptyCounts();
    for (const row of rows) {
      // A send without a variant key was accepted before identity was
      // recorded. It never counts toward a template.
      if (row.variant_key === null) {
        notRecorded = add(notRecorded, countsOf(row));
        continue;
      }
      templates.push({
        variant_key: row.variant_key,
        template_name: row.template_name,
        language: row.language,
        language_code: row.language_code,
        ...countsOf(row),
      });
    }

    return {
      range: { from: query.from, to: query.to, timezone: 'UTC' },
      include_test: includeTest,
      templates,
      not_recorded: notRecorded,
      evaluated_at: new Date().toISOString(),
    };
  }
}
