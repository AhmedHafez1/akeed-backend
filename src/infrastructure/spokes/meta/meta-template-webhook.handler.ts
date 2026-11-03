import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionTemplateHintsService } from '../../../modules/whatsapp-sender/connection-template-hints.service';
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
import {
  asRecord,
  changeIdentity,
  parseBody,
  type JsonRecord,
} from './meta-webhook-envelope';

const META_ACCOUNT_ID = /^\d{1,32}$/;

/** The template fields Akeed subscribes to, and their meaning. */
export const META_TEMPLATE_WEBHOOK_FIELDS: Record<string, TemplateEventField> =
  {
    message_template_status_update: 'status',
    message_template_quality_update: 'quality',
    template_category_update: 'category',
  };

/**
 * Template notifications on the WhatsApp webhook.
 *
 * The controller hands over the raw body its signature guard has just
 * verified: the request DTO is shaped for `messages` and `statuses`, and the
 * global validation pipe strips `field`, `entry.id`, `entry.time` and every
 * template member from it. The `messages` path is not touched.
 *
 * Contract-record rules applied here:
 * - Only the three subscribed template fields are read; anything else on the
 *   body is the message handler's, or ignored.
 * - `entry[].id` must be this environment's WhatsApp Business Account for the
 *   registry; anything else is logged and dropped from that path. Another
 *   account's events go to the merchant connection that holds it, as hints
 *   for its own rows; an account no connection holds is dropped there.
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
    @Optional()
    private readonly merchantHints?: ConnectionTemplateHintsService,
  ) {}

  /** Never throws: the webhook is answered 200 whatever happens here. */
  async handle(rawBody: Buffer | undefined): Promise<void> {
    try {
      await this.handleOrThrow(rawBody);
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

  /** For the worker, whose retries depend on seeing the failure. */
  async handleOrThrow(rawBody: Buffer | undefined): Promise<void> {
    if (!rawBody) return;
    const events = this.extract(rawBody);
    if (events.length > 0) await this.templateStatus.applyEvents(events);
    if (!this.merchantHints) return;
    for (const [wabaId, merchantEvents] of this.extractMerchant(rawBody))
      await this.merchantHints.apply(wabaId, merchantEvents);
  }

  /** The template events in a delivery, in neutral terms. */
  extract(rawBody: Buffer): TemplateProviderEvent[] {
    const templateChanges = this.templateChanges(rawBody);
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

  /**
   * Template events for accounts other than Akeed's, grouped by account id:
   * merchants' own numbers. Read whatever Akeed's own sync switch says, so a
   * connection's state stays correct; which connection an account belongs
   * to is decided by the receiver.
   */
  extractMerchant(rawBody: Buffer): Map<string, TemplateProviderEvent[]> {
    const byAccount = new Map<string, TemplateProviderEvent[]>();
    const akeedAccountId = readWhatsappTemplateConfig(
      this.config,
    ).businessAccountId;
    for (const { entry, change } of this.templateChanges(rawBody)) {
      const accountId = typeof entry.id === 'string' ? entry.id : null;
      if (
        !accountId ||
        !META_ACCOUNT_ID.test(accountId) ||
        accountId === akeedAccountId
      )
        continue;
      const field = META_TEMPLATE_WEBHOOK_FIELDS[change.field as string];
      const event = this.toEvent(field, entry, change);
      if (!event) {
        this.skip('malformed', field);
        continue;
      }
      byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), event]);
    }
    return byAccount;
  }

  private templateChanges(
    rawBody: Buffer,
  ): { entry: JsonRecord; change: JsonRecord }[] {
    const body = asRecord(parseBody(rawBody));
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    return entries.flatMap((entry) => {
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
    const identityKey = changeIdentity(change.field, entry.id, time, value);
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
        // a completed change names the new one.
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
