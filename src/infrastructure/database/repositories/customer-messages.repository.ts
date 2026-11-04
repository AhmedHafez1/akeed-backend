import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { customerMessages, orders } from '../schema';
import {
  resolveButtonPayload,
  resolveReplyText,
} from '../../../shared/verification/customer-reply-intent';
import type { WhatsAppMessageDto } from '../../spokes/meta/dto/whatsapp-webhook.dto';
import { withSerializableRetry } from '../../../shared/database/serializable-retry';

export interface ReceivingNumber {
  orgId: string | null;
  connectionId: string | null;
  signupGeneration?: number;
  phoneNumberId: string;
  wabaId: string;
}

interface ReplyTarget extends Record<string, unknown> {
  id: string;
  orgId: string;
  orderId: string;
  customerPhone: string;
}

export interface MessageAdmission {
  allowed: boolean;
  retainText: boolean;
  verificationId: string | null;
  reason?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Customer content is admitted before either the event store or reply handling. */
@Injectable()
export class CustomerMessagesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async receiptReceiverMatches(
    status: Record<string, unknown>,
    phone: string,
    waba: string,
    receiver: ReceivingNumber | null,
  ): Promise<boolean> {
    const wamid = String(status.id);
    const attemptId =
      typeof status.biz_opaque_callback_data === 'string'
        ? status.biz_opaque_callback_data
        : '';
    const rows = await this.db.execute<{
      phone: string | null;
      waba: string | null;
    }>(sql`
      SELECT a.phone_number_id AS phone, a.waba_id AS waba FROM verification_sender_attempts a
        WHERE a.provider_message_id = ${wamid} OR a.id::text = ${attemptId}
      UNION ALL
      SELECT d.sender_phone_number_id, NULL
        FROM verification_message_dispatches d
        WHERE d.provider_message_id = ${wamid} AND d.sender_kind = 'akeed_system'
      UNION ALL
      SELECT s.sender_phone_number_id, NULL FROM verification_service_messages s WHERE s.provider_message_id = ${wamid}
      UNION ALL
      SELECT NULL, NULL FROM verifications v WHERE v.wa_message_id = ${wamid}
        AND NOT EXISTS (SELECT 1 FROM verification_message_dispatches d WHERE d.provider_message_id = ${wamid})
        AND NOT EXISTS (SELECT 1 FROM verification_sender_attempts a WHERE a.provider_message_id = ${wamid})`);
    if (rows.length)
      return rows.some((row) =>
        row.phone === null
          ? Boolean(receiver && !receiver.orgId)
          : row.phone === phone &&
            (row.waba === null ? Boolean(receiver) : row.waba === waba),
      );
    // Legacy messages without a dispatch are accepted only on a known shared receiver.
    return Boolean(receiver);
  }

  async findQuoted(wamid: string): Promise<ReplyTarget | undefined> {
    const rows = await this.db.execute<ReplyTarget>(sql`
      SELECT v.id, v.org_id AS "orgId", v.order_id AS "orderId", o.customer_phone AS "customerPhone"
      FROM verifications v JOIN orders o ON o.id = v.order_id AND o.org_id = v.org_id
      WHERE v.id IN (
        SELECT id FROM verifications WHERE wa_message_id = ${wamid}
        UNION SELECT verification_id FROM verification_message_dispatches WHERE provider_message_id = ${wamid}
        UNION SELECT d.verification_id FROM verification_sender_attempts a JOIN verification_message_dispatches d ON d.id = a.dispatch_id AND d.org_id = a.org_id WHERE a.provider_message_id = ${wamid}
        UNION SELECT verification_id FROM verification_service_messages WHERE provider_message_id = ${wamid}
      )
      LIMIT 1`);
    return rows[0];
  }

  private async byId(id: string): Promise<ReplyTarget | undefined> {
    if (!UUID.test(id)) return undefined;
    const rows = await this.db.execute<ReplyTarget>(sql`
      SELECT v.id, v.org_id AS "orgId", v.order_id AS "orderId", o.customer_phone AS "customerPhone"
      FROM verifications v JOIN orders o ON o.id = v.order_id AND o.org_id = v.org_id
      WHERE v.id = ${id} LIMIT 1`);
    return rows[0];
  }

  async admit(
    route: ReceivingNumber,
    message: WhatsAppMessageDto,
  ): Promise<MessageAdmission> {
    try {
      return await withSerializableRetry(() =>
        this.db.transaction((tx) =>
          new CustomerMessagesRepository(
            tx as unknown as DrizzleDB,
          ).admitLocked(route, message),
        ),
      );
    } catch {
      throw new Error('customer_message_admission_failed');
    }
  }

  private async admitLocked(
    route: ReceivingNumber,
    message: WhatsAppMessageDto,
  ): Promise<MessageAdmission> {
    const deny = (reason: string): MessageAdmission => ({
      allowed: false,
      retainText: false,
      verificationId: null,
      reason,
    });
    const existing = message.id
      ? await this.db
          .select()
          .from(customerMessages)
          .where(eq(customerMessages.providerMessageId, message.id))
          .limit(1)
      : [];
    const saved = existing[0];
    if (
      saved &&
      (saved.redactedAt || (route.orgId && saved.orgId !== route.orgId))
    )
      return deny('redacted_or_foreign_message');
    const timestamp = Number(message.timestamp);
    if (
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      timestamp * 1000 < Date.now() - 90 * 86400_000
    )
      return deny('expired_message');
    const button = resolveButtonPayload(
      message.button?.payload ?? message.interactive?.button_reply?.id ?? '',
    );
    let target = button ? await this.byId(button.verificationId) : undefined;
    const quoted = message.context?.id
      ? await this.findQuoted(message.context.id)
      : undefined;
    // A foreign quote never becomes an unquoted phone match, even with a valid button.
    if (
      route.orgId &&
      ((target && target.orgId !== route.orgId) ||
        (quoted && quoted.orgId !== route.orgId))
    )
      return deny('foreign_verification');
    if (!target) target = quoted;
    if (saved?.verificationId && !target)
      target = await this.byId(saved.verificationId);
    if (target && !target.customerPhone) return deny('redacted_customer');
    const orgId = route.orgId ?? target?.orgId;
    if (saved && orgId !== saved.orgId) return deny('foreign_message_identity');
    const phone = normalizeCustomerPhone(message.from);
    let recentOrder = false;
    let eligibleOrderId = target?.orderId;
    if (orgId && phone) {
      const recent = await this.db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.orgId, orgId),
            inArray(orders.customerPhone, [phone, `+${phone}`]),
            sql`${orders.createdAt} >= now() - interval '30 days'`,
          ),
        )
        .limit(1);
      recentOrder = recent.length > 0;
      eligibleOrderId ??= recent[0]?.id;
    }
    if (
      !saved &&
      !target &&
      !message.context?.id &&
      !button &&
      route.orgId &&
      phone &&
      recentOrder &&
      message.text?.body &&
      resolveReplyText(message.text.body)
    ) {
      const candidates = await this.db.execute<ReplyTarget>(sql`
        SELECT v.id, v.org_id AS "orgId", v.order_id AS "orderId", o.customer_phone AS "customerPhone"
        FROM verifications v JOIN orders o ON o.id = v.order_id AND o.org_id = v.org_id
        WHERE v.org_id = ${route.orgId} AND o.customer_phone IN (${phone}, ${`+${phone}`})
          AND o.created_at >= now() - interval '30 days' AND v.merchant_canceled_at IS NULL
          AND v.status IN ('pending', 'sent', 'delivered', 'read')
        LIMIT 2`);
      if (candidates.length === 1) target = candidates[0];
    }
    const retainText = Boolean(
      message.text?.body && orgId && (quoted || recentOrder || saved),
    );
    if (eligibleOrderId && orgId) {
      const live = await this.db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.id, eligibleOrderId),
            eq(orders.orgId, orgId),
            sql`${orders.customerPhone} <> ''`,
          ),
        )
        .for('share');
      if (!live.length) return deny('redacted_customer');
    }
    if (retainText && message.id && orgId) {
      const seconds = Number(message.timestamp);
      const receivedAt =
        Number.isFinite(seconds) && seconds > 0 && seconds * 1000 <= Date.now()
          ? new Date(seconds * 1000).toISOString()
          : new Date().toISOString();
      // Redaction keeps a content-free tombstone: a redelivery cannot resurrect it.
      await this.db
        .insert(customerMessages)
        .values({
          orgId,
          connectionId: route.connectionId,
          verificationId: target?.id ?? null,
          providerMessageId: message.id,
          customerPhone: phone,
          customerUserId: message.from_user_id ?? null,
          messageType: message.type ?? 'text',
          body: message.text!.body!,
          receivedAt,
          expiresAt: new Date(
            new Date(receivedAt).getTime() + 90 * 86400_000,
          ).toISOString(),
        })
        .onConflictDoNothing({ target: customerMessages.providerMessageId });
    }
    return { allowed: true, retainText, verificationId: target?.id ?? null };
  }

  async purge(): Promise<number> {
    let deleted = 0;
    for (let batch = 0; batch < 10; batch++) {
      const rows = await this.db.execute(sql`
        DELETE FROM customer_messages WHERE id IN (
          SELECT id FROM customer_messages WHERE expires_at <= now() ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
        ) RETURNING id`);
      deleted += rows.length;
      if (rows.length < 500) break;
    }
    return deleted;
  }
}

export function normalizeCustomerPhone(
  value: string | undefined,
): string | null {
  if (!value || !/^\+?[0-9 ()-]{6,32}$/.test(value)) return null;
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length >= 6 && digits.length <= 15 ? digits : null;
}
