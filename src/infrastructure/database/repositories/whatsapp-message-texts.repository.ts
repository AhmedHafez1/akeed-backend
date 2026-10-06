import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { whatsappMessageTextEvents, whatsappMessageTexts } from '../schema';
import type {
  MessageText,
  MessageTextPurpose,
} from '../../../shared/messaging/message-texts.types';
import type { TemplateLanguage } from '../../../shared/messaging/template-registry.types';
import { insertTemplateAudit } from './whatsapp-template-drafts.repository';

type MessageTextRow = typeof whatsappMessageTexts.$inferSelect;

function toMessageText(row: MessageTextRow): MessageText {
  return {
    id: row.id,
    purpose: row.purpose,
    language: row.language,
    style: row.style,
    body: row.body,
    isActive: row.isActive,
    updatedAt: row.updatedAt,
  };
}

export interface MessageTextWrite {
  purpose: MessageTextPurpose;
  language: TemplateLanguage;
  style: string;
  body: string;
  isActive: boolean;
  userId: string;
  requestId?: string;
  /** The `admin_access_audit` action. */
  auditAction: string;
}

export interface MessageTextWriteResult {
  text: MessageText;
  action: 'create' | 'update' | 'unchanged';
}

/**
 * The free-form copy staff manage (US-08-07). Global, like the template
 * registry: every text belongs to the single Akeed sender.
 */
@Injectable()
export class WhatsappMessageTextsRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: DrizzleDB,
  ) {}

  /** Every text, inactive ones included, in a stable order. */
  async findAll(): Promise<MessageText[]> {
    const rows = await this.db
      .select()
      .from(whatsappMessageTexts)
      .orderBy(
        asc(whatsappMessageTexts.purpose),
        asc(whatsappMessageTexts.language),
        asc(whatsappMessageTexts.style),
      );
    return rows.map(toMessageText);
  }

  /**
   * Creates or replaces one text, and records the change, its event row and
   * its audit row in one transaction. A write that changes nothing records
   * nothing.
   */
  async upsert(input: MessageTextWrite): Promise<MessageTextWriteResult> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(whatsappMessageTexts)
        .where(
          and(
            eq(whatsappMessageTexts.purpose, input.purpose),
            eq(whatsappMessageTexts.language, input.language),
            eq(whatsappMessageTexts.style, input.style),
          ),
        )
        .for('update')
        .limit(1);
      if (
        current &&
        current.body === input.body &&
        current.isActive === input.isActive
      ) {
        return { text: toMessageText(current), action: 'unchanged' as const };
      }

      const [saved] = current
        ? await tx
            .update(whatsappMessageTexts)
            .set({
              body: input.body,
              isActive: input.isActive,
              updatedBy: input.userId,
              updatedAt: sql`now()`,
            })
            .where(eq(whatsappMessageTexts.id, current.id))
            .returning()
        : await tx
            .insert(whatsappMessageTexts)
            .values({
              purpose: input.purpose,
              language: input.language,
              style: input.style,
              body: input.body,
              isActive: input.isActive,
              updatedBy: input.userId,
            })
            .onConflictDoNothing()
            .returning();
      if (!saved) {
        // Another operator created the same text a moment ago; read theirs.
        throw new MessageTextConflictError();
      }
      const action = current ? ('update' as const) : ('create' as const);
      await tx.insert(whatsappMessageTextEvents).values({
        textId: saved.id,
        action,
        previousBody: current?.body ?? null,
        body: saved.body,
        previousIsActive: current?.isActive ?? null,
        isActive: saved.isActive,
        changedBy: input.userId,
        requestId: input.requestId,
      });
      await insertTemplateAudit(tx, {
        userId: input.userId,
        action: input.auditAction,
        requestId: input.requestId,
        metadata: {
          textId: saved.id,
          purpose: saved.purpose,
          language: saved.language,
          style: saved.style,
          change: action,
          isActiveBefore: current?.isActive ?? null,
          isActiveAfter: saved.isActive,
          bodyChanged: current ? current.body !== saved.body : true,
        },
      });
      return { text: toMessageText(saved), action };
    });
  }

  /** The newest changes to one text, newest first. */
  async eventsFor(textId: string, limit = 20) {
    return this.db
      .select({
        action: whatsappMessageTextEvents.action,
        previousBody: whatsappMessageTextEvents.previousBody,
        body: whatsappMessageTextEvents.body,
        previousIsActive: whatsappMessageTextEvents.previousIsActive,
        isActive: whatsappMessageTextEvents.isActive,
        changedBy: whatsappMessageTextEvents.changedBy,
        changedAt: whatsappMessageTextEvents.changedAt,
      })
      .from(whatsappMessageTextEvents)
      .where(eq(whatsappMessageTextEvents.textId, textId))
      .orderBy(sql`${whatsappMessageTextEvents.changedAt} DESC`)
      .limit(limit);
  }
}

/** Two operators created the same text at once; the second is refused. */
export class MessageTextConflictError extends Error {
  constructor() {
    super('message_text_conflict');
  }
}
