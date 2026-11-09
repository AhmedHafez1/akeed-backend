import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import {
  CustomerMessagesRepository,
  type ReceivingNumber,
} from '../../database/repositories/customer-messages.repository';
import { WhatsappConnectionsRepository } from '../../database/repositories/whatsapp-connections.repository';
import { ConnectionLifecycleService } from '../../../modules/whatsapp-sender/connection-lifecycle.service';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import { readWhatsappTemplateConfig } from '../../../shared/config/whatsapp-template.config';
import {
  WhatsAppWebhookPayloadDto,
  WhatsAppMessageDto,
} from './dto/whatsapp-webhook.dto';
import {
  asRecord,
  changeIdentity,
  parseBody,
  type JsonRecord,
} from './meta-webhook-envelope';
import {
  WhatsAppWebhookService,
  type WebhookRunOptions,
} from './whatsapp.webhook.service';
import {
  MetaTemplateWebhookHandler,
  META_TEMPLATE_WEBHOOK_FIELDS,
} from './meta-template-webhook.handler';

const IGNORED = new Set([
  'smb_message_echoes',
  'history',
  'smb_app_state_sync',
]);
const ACCOUNT_FIELDS = new Set([
  'account_update',
  'phone_number_quality_update',
  'account_review_update',
  'business_capability_update',
]);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const digits = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/[^0-9]/g, '') : '';

/** The same signed-envelope router serves inline requests and durable jobs. */
@Injectable()
export class MetaWebhookRoutingService {
  private readonly logger = new Logger(MetaWebhookRoutingService.name);
  constructor(
    private readonly config: ConfigService,
    private readonly connections: WhatsappConnectionsRepository,
    private readonly customers: CustomerMessagesRepository,
    private readonly messages: WhatsAppWebhookService,
    private readonly templates: MetaTemplateWebhookHandler,
    private readonly lifecycle: ConnectionLifecycleService,
  ) {}

  /** Drops unrelated content before durable persistence, retaining original dedupe identities. */
  async prepare(
    rawBody: Buffer,
    customers: CustomerMessagesRepository = this.customers,
  ): Promise<Buffer> {
    const body = asRecord(parseBody(rawBody));
    if (!body || !Array.isArray(body.entry))
      throw new Error('invalid_webhook_envelope');
    const entries: JsonRecord[] = [];
    for (const rawEntry of body.entry) {
      const entry = asRecord(rawEntry);
      if (!entry || !Array.isArray(entry.changes)) continue;
      const changes: JsonRecord[] = [];
      for (const rawChange of entry.changes) {
        const change = asRecord(rawChange);
        if (!change) continue;
        const field = text(change.field);
        const value = asRecord(change.value) ?? {};
        const identity = changeIdentity(field, entry.id, entry.time, value);
        let safe: JsonRecord = {};
        if (field === 'messages') {
          const metadata = asRecord(value.metadata) ?? {};
          const receiver = await this.receiver(
            text(metadata.phone_number_id),
            text(entry.id),
          );
          safe = {
            metadata: { phone_number_id: text(metadata.phone_number_id) },
          };
          // Status snapshots can outlive their connection. Their own ledger checks the receiver.
          safe.statuses = await this.safeStatuses(
            value.statuses,
            receiver,
            text(metadata.phone_number_id),
            text(entry.id),
          );
          const admitted: WhatsAppMessageDto[] = [];
          if (receiver)
            for (const item of Array.isArray(value.messages)
              ? value.messages
              : []) {
              const message = this.message(asRecord(item));
              if (!message) continue;
              const admission = await customers.admit(receiver, message);
              if (!admission.allowed) {
                this.skip(
                  admission.reason ?? 'message_refused',
                  field,
                  receiver.orgId,
                );
                continue;
              }
              if (!admission.retainText) {
                message.text = undefined;
                // A bound button retains its recipient identity for dispatch validation after durable intake.
                if (
                  !message.button?.payload &&
                  !message.interactive?.button_reply?.id
                )
                  message.from = undefined;
                message.from_user_id = undefined;
              }
              admitted.push(message);
            }
          safe.messages = admitted;
        } else if (
          field &&
          Object.hasOwn(META_TEMPLATE_WEBHOOK_FIELDS, field)
        ) {
          // The existing template mapper owns these fields; no customer content is needed.
          safe = Object.fromEntries(
            [
              'event',
              'message_template_id',
              'message_template_name',
              'message_template_language',
              'reason',
              'new_quality_score',
              'new_category',
              'correct_category',
              'previous_category',
              'new_template_category',
            ]
              .filter((key) => value[key] !== undefined)
              .map((key) => [key, value[key]]),
          );
        } else if (field && ACCOUNT_FIELDS.has(field)) {
          safe = {
            event: text(value.event),
            display_phone_number: text(value.display_phone_number),
            phone_number: text(value.phone_number),
            disconnection_info: {
              reason: text(asRecord(value.disconnection_info)?.reason),
            },
          };
        } else if (field && IGNORED.has(field)) {
          safe = {
            metadata: {
              phone_number_id: text(asRecord(value.metadata)?.phone_number_id),
            },
          };
        }
        changes.push({ field, value: safe, akeed_dedupe_hash: identity });
      }
      entries.push({
        id: text(entry.id),
        time: typeof entry.time === 'number' ? entry.time : undefined,
        changes,
      });
    }
    return Buffer.from(
      JSON.stringify({ object: 'whatsapp_business_account', entry: entries }),
    );
  }

  async process(
    rawBody: Buffer,
    options: WebhookRunOptions = {},
  ): Promise<void> {
    const body = asRecord(parseBody(rawBody));
    for (const rawEntry of Array.isArray(body?.entry) ? body.entry : []) {
      const entry = asRecord(rawEntry);
      for (const rawChange of Array.isArray(entry?.changes)
        ? entry.changes
        : []) {
        const change = asRecord(rawChange);
        const value = asRecord(change?.value) ?? {};
        const field = text(change?.field);
        if (!field) {
          this.skip('missing_field');
          continue;
        }
        if (IGNORED.has(field)) {
          this.skip('ignored_content', field);
          continue;
        }
        const wabaId = text(entry?.id);
        if (field === 'messages') {
          const phoneNumberId = text(asRecord(value.metadata)?.phone_number_id);
          const receiver = await this.receiver(phoneNumberId, wabaId);
          const bindings: Record<string, string> = {};
          const admitted: WhatsAppMessageDto[] = [];
          if (receiver)
            for (const item of Array.isArray(value.messages)
              ? value.messages
              : []) {
              const message = this.message(asRecord(item));
              if (!message) continue;
              const admission = await this.customers.admit(receiver, message);
              if (!admission.allowed) {
                this.skip(
                  admission.reason ?? 'message_refused',
                  field,
                  receiver.orgId,
                );
                continue;
              }
              if (!admission.retainText) message.text = undefined;
              if (message.id && admission.verificationId)
                bindings[message.id] = admission.verificationId;
              admitted.push(message);
            }
          const statuses = await this.safeStatuses(
            value.statuses,
            receiver,
            phoneNumberId,
            wabaId,
          );
          const dto = plainToInstance(WhatsAppWebhookPayloadDto, {
            entry: [
              {
                id: wabaId,
                changes: [
                  {
                    field,
                    value: {
                      metadata: { phone_number_id: phoneNumberId },
                      messages: admitted,
                      statuses,
                    },
                  },
                ],
              },
            ],
          });
          await this.messages.processIncomingOrThrow(dto, {
            ...options,
            receivingOrgId: receiver?.orgId ?? undefined,
            receivingSender: receiver?.connectionId
              ? {
                  connectionId: receiver.connectionId,
                  phoneNumberId: receiver.phoneNumberId,
                  signupGeneration: receiver.signupGeneration!,
                }
              : undefined,
            replyBindings: bindings,
          });
        } else if (Object.hasOwn(META_TEMPLATE_WEBHOOK_FIELDS, field)) {
          await this.templates.handleOrThrow(
            Buffer.from(
              JSON.stringify({ entry: [{ ...entry, changes: [change] }] }),
            ),
          );
        } else if (ACCOUNT_FIELDS.has(field) && wabaId) {
          const connection = await this.connections.findLiveByWabaId(wabaId);
          if (!connection) {
            this.skip('unknown_account', field);
            continue;
          }
          const eventPhone = value.display_phone_number ?? value.phone_number;
          if (
            eventPhone !== undefined &&
            (!digits(eventPhone) ||
              digits(eventPhone) !== digits(connection.displayPhoneNumber))
          ) {
            this.skip('wrong_display_number', field, connection.orgId);
            continue;
          }
          if (field === 'account_update') {
            const seconds =
              typeof entry?.time === 'number' ? entry.time : undefined;
            // Intake time is stable across retries when Meta omits its timestamp.
            const occurredAt =
              seconds &&
              Number.isFinite(seconds) &&
              seconds > 0 &&
              seconds * 1000 <= Date.now() + 300_000
                ? new Date(seconds * 1000).toISOString()
                : (options.receivedAt ?? new Date().toISOString());
            await this.lifecycle.apply(connection, {
              event: text(value.event) ?? '',
              reason: asRecord(value.disconnection_info)?.reason,
              eventKey:
                text(change?.akeed_dedupe_hash) ??
                changeIdentity(field, wabaId, entry?.time, value),
              occurredAt,
            });
          } else {
            this.skip('health_refresh_requested', field, connection.orgId);
            await this.lifecycle.requestHealth(connection);
          }
        } else this.skip('unknown_field_or_account', field);
      }
    }
  }

  private async receiver(
    phoneNumberId?: string,
    wabaId?: string,
  ): Promise<ReceivingNumber | null> {
    if (!phoneNumberId || !wabaId) {
      this.skip('missing_receiver', 'messages');
      return null;
    }
    if (
      phoneNumberId === this.config.get<string>('WA_PHONE_NUMBER_ID') &&
      wabaId === readWhatsappTemplateConfig(this.config).businessAccountId
    )
      return { orgId: null, connectionId: null, phoneNumberId, wabaId };
    const connection =
      await this.connections.findLiveByPhoneNumberId(phoneNumberId);
    if (!connection || connection.wabaId !== wabaId) {
      this.skip('unknown_receiver', 'messages');
      return null;
    }
    return {
      orgId: connection.orgId,
      connectionId: connection.id,
      signupGeneration: connection.signupGeneration,
      phoneNumberId,
      wabaId,
    };
  }

  private async safeStatuses(
    raw: unknown,
    receiver: ReceivingNumber | null,
    phone?: string,
    waba?: string,
  ) {
    const statuses: JsonRecord[] = [];
    if (!phone || !waba) return statuses;
    for (const item of Array.isArray(raw) ? raw : []) {
      const status = asRecord(item);
      if (!status || !text(status.id) || !text(status.status)) continue;
      if (
        !(await this.customers.receiptReceiverMatches(
          status,
          phone,
          waba,
          receiver,
        ))
      ) {
        this.skip('receipt_receiver_mismatch', 'messages', receiver?.orgId);
        continue;
      }
      const error = asRecord(
        Array.isArray(status.errors) ? status.errors[0] : undefined,
      );
      statuses.push({
        id: text(status.id),
        status: text(status.status),
        timestamp: text(status.timestamp),
        biz_opaque_callback_data: text(status.biz_opaque_callback_data),
        errors: error
          ? [
              {
                code:
                  typeof error.code === 'number' ||
                  typeof error.code === 'string'
                    ? error.code
                    : undefined,
              },
            ]
          : undefined,
      });
    }
    return statuses;
  }

  private message(raw: JsonRecord | null): WhatsAppMessageDto | null {
    if (!raw || !text(raw.id)) return null;
    const body = text(asRecord(raw.text)?.body);
    const seconds = Number(raw.timestamp);
    return {
      id: text(raw.id),
      from: text(raw.from),
      from_user_id: text(raw.from_user_id),
      timestamp:
        Number.isFinite(seconds) &&
        seconds > 0 &&
        seconds * 1000 <= Date.now() + 300_000
          ? String(seconds)
          : undefined,
      type: text(raw.type),
      text: body ? { body } : undefined,
      context: { id: text(asRecord(raw.context)?.id) },
      button: { payload: text(asRecord(raw.button)?.payload) },
      interactive: {
        button_reply: {
          id: text(asRecord(asRecord(raw.interactive)?.button_reply)?.id),
        },
      },
    };
  }

  private skip(reason: string, field?: string, orgId?: string | null) {
    this.logger.warn(
      buildBackendLog(MetaWebhookRoutingService.name, {
        action: 'meta-webhook-route',
        outcome: 'skipped',
        reason,
        field,
        orgId: orgId ?? undefined,
      }),
    );
  }
}
