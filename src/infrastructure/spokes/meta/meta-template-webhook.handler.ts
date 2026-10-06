import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { readWhatsappTemplateConfig } from '../../../shared/config/whatsapp-template.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import type {
  TemplateEventField,
  TemplateProviderEvent,
} from '../../../shared/messaging/template-provider.types';
import { TemplateStatusService } from '../../../modules/template-registry/template-status.service';
import {
  mapCategory,
  mapQuality,
  mapRejectionReason,
  mapWebhookEvent,
  normalizeLanguageCode,
} from './meta-template.mapping';

/** The template fields Akeed subscribes to (record 4.8.1), and their meaning. */
export const META_TEMPLATE_WEBHOOK_FIELDS: Record<string, TemplateEventField> =
  {
    message_template_status_update: 'status',
    message_template_quality_update: 'quality',
    template_category_update: 'category',
  };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/**
 * Parses the signed body. `message_template_id` is an integer that can be
 * larger than 2^53 (record 4.8.12), so its source text is kept as a string
 * instead of a rounded number.
 */
function parseBody(rawBody: Buffer): unknown {
  return JSON.parse(
    rawBody.toString('utf8'),
    (key: string, value: unknown, context?: { source?: string }) =>
      key === 'message_template_id' && typeof value === 'number'
        ? (context?.source ?? String(value))
        : value,
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Template notifications on the WhatsApp webhook (US-08-04 criterion 3).
 *
 * The controller hands over the raw body its signature guard has just
 * verified: the request DTO is shaped for `messages` and `statuses`, and the
 * global validation pipe strips `field`, `entry.id`, `entry.time` and every
 * template member from it. The `messages` path is not touched.
 *
 * Contract-record rules applied here:
 * - Only the three subscribed template fields are read; anything else on the
 *   body is the message handler's, or ignored.
 * - `entry[].id` must be this environment's WhatsApp Business Account;
 *   anything else is logged and dropped.
 * - The provider sends no event ID (4.8.14). An event's identity is the field,
 *   `entry[].id`, `entry[].time` and a hash of `value`; `entry[].time` is its
 *   time.
 * - Values are mapped to neutral ones here, and an unlisted value is
 *   `unknown`.
 * - Nothing waits on a sync before the webhook is answered.
 */
@Injectable()
export class MetaTemplateWebhookHandler {
  private readonly logger = new Logger(MetaTemplateWebhookHandler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly templateStatus: TemplateStatusService,
  ) {}

  /** Never throws: the webhook is answered 200 whatever happens here. */
  async handle(rawBody: Buffer | undefined): Promise<void> {
    if (!rawBody) return;
    try {
      const events = this.extract(rawBody);
      if (events.length === 0) return;
      await this.templateStatus.applyEvents(events);
    } catch (error) {
      this.logger.error(
        buildBackendLog(MetaTemplateWebhookHandler.name, {
          action: 'meta-template-webhook',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
    }
  }

  /** The template events in a delivery, in neutral terms. */
  extract(rawBody: Buffer): TemplateProviderEvent[] {
    const body = asRecord(parseBody(rawBody));
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    const templateChanges = entries.flatMap((entry) => {
      const record = asRecord(entry);
      const changes = Array.isArray(record?.changes) ? record.changes : [];
      return changes
        .map((change) => asRecord(change))
        .filter(
          (change): change is JsonRecord =>
            change !== null &&
            typeof change.field === 'string' &&
            Object.hasOwn(META_TEMPLATE_WEBHOOK_FIELDS, change.field),
        )
        .map((change) => ({ entry: record!, change }));
    });
    if (templateChanges.length === 0) return [];

    const config = readWhatsappTemplateConfig(this.config);
    if (!config.syncEnabled) {
      this.logger.log(
        buildBackendLog(MetaTemplateWebhookHandler.name, {
          action: 'meta-template-webhook',
          outcome: 'skipped',
          reason: 'template_sync_disabled',
          changeCount: templateChanges.length,
        }),
      );
      return [];
    }

    const events: TemplateProviderEvent[] = [];
    for (const { entry, change } of templateChanges) {
      const field = META_TEMPLATE_WEBHOOK_FIELDS[change.field as string];
      const accountId = typeof entry.id === 'string' ? entry.id : null;
      if (!accountId || accountId !== config.businessAccountId) {
        this.skip('wrong_account', field);
        continue;
      }
      const event = this.toEvent(field, entry, change);
      if (event) events.push(event);
      else this.skip('malformed', field);
    }
    return events;
  }

  private toEvent(
    field: TemplateEventField,
    entry: JsonRecord,
    change: JsonRecord,
  ): TemplateProviderEvent | null {
    const value = asRecord(change.value);
    const time = entry.time;
    if (
      !value ||
      typeof time !== 'number' ||
      !Number.isFinite(time) ||
      typeof value.message_template_name !== 'string' ||
      typeof value.message_template_language !== 'string'
    ) {
      return null;
    }
    const identityKey = createHash('sha256')
      .update(
        [
          change.field,
          entry.id,
          String(time),
          createHash('sha256').update(canonicalJson(value)).digest('hex'),
        ].join('|'),
      )
      .digest('hex');
    const templateId = value.message_template_id;
    const base = {
      field,
      identityKey,
      occurredAt: new Date(time * 1000).toISOString(),
      templateName: value.message_template_name,
      languageCode: normalizeLanguageCode(value.message_template_language),
      providerTemplateId:
        typeof templateId === 'string' || typeof templateId === 'number'
          ? String(templateId)
          : null,
    };
    switch (field) {
      case 'status':
        return {
          ...base,
          status: mapWebhookEvent(value.event),
          rejectionReason: mapRejectionReason(value.reason) ?? null,
        };
      case 'quality':
        return { ...base, quality: mapQuality(value.new_quality_score) };
      case 'category': {
        // A scheduled change names the current category and the coming one;
        // a completed change names the new one (record 4.8.10).
        const category = mapCategory(value.new_category);
        const coming =
          value.correct_category === undefined ||
          value.correct_category === null
            ? null
            : mapCategory(value.correct_category);
        return {
          ...base,
          category,
          pendingCategory: coming && coming !== category ? coming : null,
        };
      }
    }
  }

  private skip(reason: string, field: TemplateEventField): void {
    this.logger.warn(
      buildBackendLog(MetaTemplateWebhookHandler.name, {
        action: 'meta-template-webhook',
        outcome: 'skipped',
        reason,
        field,
      }),
    );
  }
}
