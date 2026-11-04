import { ConfigService } from '@nestjs/config';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  verificationReplyEvents,
  verificationServiceMessages,
} from '../schema';
import type {
  MessageTextPurpose,
  ServiceMessageKind,
  ServiceMessageSkipReason,
} from '../../../shared/messaging/message-texts.types';
import type { TemplateLanguage } from '../../../shared/messaging/template-registry.types';
import type { MerchantReplySender } from '../../../shared/messaging/merchant-reply-sender';

/**
 * Acknowledgments and nudges, and the unresolved replies a
 * nudge answers. Every write is row-guarded: a row is claimed once per
 * verification and kind, and moves out of `claimed` once.
 */
@Injectable()
export class VerificationServiceMessagesRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: DrizzleDB,
    private readonly config?: ConfigService,
  ) {}

  /**
   * Claims the one message of this kind a verification may ever get. NULL
   * when it was claimed before: a replayed webhook or a second job sends
   * nothing.
   */
  async claim(params: {
    orgId: string;
    verificationId: string;
    kind: ServiceMessageKind;
    repliedAt: string;
    sender?: MerchantReplySender;
  }): Promise<{ id: string } | null> {
    const [claimed] = await this.db
      .insert(verificationServiceMessages)
      .values({
        orgId: params.orgId,
        verificationId: params.verificationId,
        kind: params.kind,
        repliedAt: params.repliedAt,
        senderKind: params.sender ? 'merchant_own' : 'akeed_system',
        senderReason: params.sender
          ? 'own_number_thank_you'
          : 'service_message',
        senderPhoneNumberId:
          params.sender?.phoneNumberId ??
          this.config?.get<string>('WA_PHONE_NUMBER_ID') ??
          null,
      })
      .onConflictDoNothing({
        target: [
          verificationServiceMessages.verificationId,
          verificationServiceMessages.kind,
        ],
      })
      .returning({ id: verificationServiceMessages.id });
    return claimed ?? null;
  }

  async isClaimedMerchantAcknowledgment(params: {
    orgId: string;
    serviceMessageId: string;
    verificationId: string;
    phoneNumberId: string;
  }): Promise<boolean> {
    const [row] = await this.db
      .select({ id: verificationServiceMessages.id })
      .from(verificationServiceMessages)
      .where(
        and(
          eq(verificationServiceMessages.id, params.serviceMessageId),
          eq(verificationServiceMessages.orgId, params.orgId),
          eq(verificationServiceMessages.verificationId, params.verificationId),
          eq(verificationServiceMessages.kind, 'acknowledgment'),
          eq(verificationServiceMessages.state, 'claimed'),
          eq(verificationServiceMessages.senderKind, 'merchant_own'),
          eq(
            verificationServiceMessages.senderPhoneNumberId,
            params.phoneNumberId,
          ),
          isNull(verificationServiceMessages.dispatchId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async linkDispatch(
    id: string,
    orgId: string,
    dispatchId: string,
  ): Promise<void> {
    const rows = await this.db
      .update(verificationServiceMessages)
      .set({
        dispatchId,
        senderKind: sql`(SELECT sender_kind FROM verification_message_dispatches WHERE id = ${dispatchId} AND org_id = ${orgId})`,
        senderReason: sql`(SELECT sender_reason FROM verification_message_dispatches WHERE id = ${dispatchId} AND org_id = ${orgId})`,
        senderPhoneNumberId: sql`(SELECT sender_phone_number_id FROM verification_message_dispatches WHERE id = ${dispatchId} AND org_id = ${orgId})`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(verificationServiceMessages.id, id),
          eq(verificationServiceMessages.orgId, orgId),
          eq(verificationServiceMessages.state, 'claimed'),
          isNull(verificationServiceMessages.dispatchId),
        ),
      )
      .returning({ id: verificationServiceMessages.id });
    if (rows.length !== 1)
      throw new Error('Service message dispatch link conflict');
  }

  async markSent(params: {
    id: string;
    providerMessageId: string;
    sentAt: string;
    text: TextIdentity;
  }): Promise<void> {
    await this.db
      .update(verificationServiceMessages)
      .set({
        state: sql`CASE WHEN EXISTS (SELECT 1 FROM verification_message_dispatches dispatch WHERE dispatch.id = ${verificationServiceMessages.dispatchId} AND dispatch.org_id = ${verificationServiceMessages.orgId} AND dispatch.failed_at IS NOT NULL) THEN 'failed' ELSE 'sent' END`,
        skipReason: sql`CASE WHEN EXISTS (SELECT 1 FROM verification_message_dispatches dispatch WHERE dispatch.id = ${verificationServiceMessages.dispatchId} AND dispatch.org_id = ${verificationServiceMessages.orgId} AND dispatch.failed_at IS NOT NULL) THEN 'delivery_failed' ELSE NULL END`,
        providerMessageId: params.providerMessageId,
        sentAt: params.sentAt,
        ...textColumns(params.text),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(verificationServiceMessages.id, params.id),
          eq(verificationServiceMessages.state, 'claimed'),
        ),
      );
  }

  /** `skipped` is expected; `failed` is anything else. */
  async markNotSent(params: {
    id: string;
    state: 'skipped' | 'failed';
    reason: ServiceMessageSkipReason;
    text?: Partial<TextIdentity>;
  }): Promise<void> {
    await this.db
      .update(verificationServiceMessages)
      .set({
        state: params.state,
        skipReason: params.reason,
        ...textColumns(params.text ?? {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(verificationServiceMessages.id, params.id),
          eq(verificationServiceMessages.state, 'claimed'),
        ),
      );
  }

  /**
   * A failed delivery receipt for a service message. Touches only that row,
   * never a verification or a dispatch. False when the id is not a service
   * message's.
   */
  async recordDeliveryFailure(providerMessageId: string): Promise<boolean> {
    const [found] = await this.db
      .select({
        id: verificationServiceMessages.id,
        state: verificationServiceMessages.state,
      })
      .from(verificationServiceMessages)
      .where(
        and(
          eq(verificationServiceMessages.providerMessageId, providerMessageId),
          isNull(verificationServiceMessages.dispatchId),
        ),
      )
      .limit(1);
    if (!found) return false;
    if (found.state === 'sent') {
      await this.db
        .update(verificationServiceMessages)
        .set({
          state: 'failed',
          skipReason: 'delivery_failed',
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(verificationServiceMessages.id, found.id),
            eq(verificationServiceMessages.state, 'sent'),
          ),
        );
    }
    return true;
  }

  /** Whether a provider message id is a service message's. */
  async isServiceMessage(providerMessageId: string): Promise<boolean> {
    const [found] = await this.db
      .select({ id: verificationServiceMessages.id })
      .from(verificationServiceMessages)
      .where(
        and(
          eq(verificationServiceMessages.providerMessageId, providerMessageId),
          isNull(verificationServiceMessages.dispatchId),
        ),
      )
      .limit(1);
    return Boolean(found);
  }

  /**
   * Stores one unresolved typed reply, without its text. A redelivery of the
   * same provider message is stored once; the result says whether this call
   * stored it.
   */
  async recordUnresolvedReply(params: {
    orgId: string;
    verificationId: string;
    providerMessageId: string;
    receivedAt: string;
  }): Promise<boolean> {
    const inserted = await this.db
      .insert(verificationReplyEvents)
      .values({
        orgId: params.orgId,
        verificationId: params.verificationId,
        kind: 'unresolved_reply',
        providerMessageId: params.providerMessageId,
        receivedAt: params.receivedAt,
      })
      .onConflictDoNothing({
        target: verificationReplyEvents.providerMessageId,
      })
      .returning({ id: verificationReplyEvents.id });
    return inserted.length > 0;
  }
}

/** Which text a service message carried: identifiers only, never the body. */
export interface TextIdentity {
  purpose: MessageTextPurpose;
  style: string;
  language: TemplateLanguage;
}

function textColumns(text: Partial<TextIdentity>) {
  return {
    ...(text.purpose ? { textPurpose: text.purpose } : {}),
    ...(text.style ? { textStyle: text.style } : {}),
    ...(text.language ? { language: text.language } : {}),
  };
}
