import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
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

/**
 * Acknowledgments and nudges (US-08-07 b, c), and the unresolved replies a
 * nudge answers. Every write is row-guarded: a row is claimed once per
 * verification and kind, and moves out of `claimed` once.
 */
@Injectable()
export class VerificationServiceMessagesRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: DrizzleDB,
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
  }): Promise<{ id: string } | null> {
    const [claimed] = await this.db
      .insert(verificationServiceMessages)
      .values({
        orgId: params.orgId,
        verificationId: params.verificationId,
        kind: params.kind,
        repliedAt: params.repliedAt,
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

  async markSent(params: {
    id: string;
    providerMessageId: string;
    sentAt: string;
    text: TextIdentity;
  }): Promise<void> {
    await this.db
      .update(verificationServiceMessages)
      .set({
        state: 'sent',
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

  /** `skipped` is expected (record 4.10.3); `failed` is anything else. */
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
        eq(verificationServiceMessages.providerMessageId, providerMessageId),
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
        eq(verificationServiceMessages.providerMessageId, providerMessageId),
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
