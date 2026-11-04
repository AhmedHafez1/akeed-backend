import type { SelectedCodTemplate } from '../../../shared/messaging/cod-template-selector';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import {
  whatsappConnectionTemplates,
  whatsappTemplates,
  type WhatsappTemplateDriftReason,
} from '../schema';
import { databaseErrorCode } from '../../../shared/database/serializable-retry';
import { violatedConstraint } from './whatsapp-connections.repository';

type Database = PostgresJsDatabase<typeof schema>;

export type WhatsappConnectionTemplateRecord =
  typeof whatsappConnectionTemplates.$inferSelect;

export interface SaveWhatsappConnectionTemplateInput {
  connectionId: string;
  templateId: string;
  metaLanguageCode: string;
  metaTemplateId?: string | null;
  status?: string;
  category?: string | null;
  quality?: string | null;
  rejectionReason?: string | null;
  submittedAt?: string | null;
  statusEventAt?: string | null;
  lastError?: string | null;
}

/**
 * Fields a submission or a sync may write. `'now'` stands for the database
 * clock, so the time is the server's and never the worker's.
 */
export interface WhatsappConnectionTemplatePatch {
  metaTemplateId?: string | null;
  metaLanguageCode?: string;
  status?: string;
  category?: string | null;
  quality?: string | null;
  rejectionReason?: string | null;
  submittedAt?: 'now' | null;
  statusEventAt?: string | null;
  lastError?: string | null;
  lastErrorCode?: string | null;
  nextAttemptAt?: string | null;
  leaseUntil?: string | null;
  submittedComponentsHash?: string | null;
  driftAt?: 'now' | null;
  driftReason?: WhatsappTemplateDriftReason | null;
  lastSyncedAt?: 'now';
}

const CONNECTION_FKEY = 'whatsapp_connection_templates_connection_fkey';

@Injectable()
export class WhatsappConnectionTemplatesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Exact text template and language selected for this send, scoped to its tenant. */
  async findForSend(
    orgId: string,
    connectionId: string,
    template: SelectedCodTemplate,
  ) {
    if (!template.registryKey) return null;
    const [row] = await this.db
      .select({
        status: whatsappConnectionTemplates.status,
        category: whatsappConnectionTemplates.category,
      })
      .from(whatsappConnectionTemplates)
      .innerJoin(
        whatsappTemplates,
        eq(whatsappTemplates.id, whatsappConnectionTemplates.templateId),
      )
      .where(
        and(
          eq(whatsappConnectionTemplates.orgId, orgId),
          eq(whatsappConnectionTemplates.connectionId, connectionId),
          eq(whatsappTemplates.key, template.registryKey),
          eq(whatsappTemplates.language, template.language),
          eq(whatsappTemplates.metaTemplateName, template.templateName),
          eq(whatsappTemplates.metaLanguageCode, template.languageCode),
          eq(
            whatsappConnectionTemplates.metaLanguageCode,
            template.languageCode,
          ),
          eq(whatsappTemplates.headerFormat, 'none'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listForOrg(orgId: string): Promise<WhatsappConnectionTemplateRecord[]> {
    return this.db
      .select()
      .from(whatsappConnectionTemplates)
      .where(eq(whatsappConnectionTemplates.orgId, orgId))
      .orderBy(whatsappConnectionTemplates.createdAt);
  }

  async listForConnection(
    orgId: string,
    connectionId: string,
  ): Promise<WhatsappConnectionTemplateRecord[]> {
    return this.db
      .select()
      .from(whatsappConnectionTemplates)
      .where(
        and(
          eq(whatsappConnectionTemplates.orgId, orgId),
          eq(whatsappConnectionTemplates.connectionId, connectionId),
        ),
      )
      .orderBy(whatsappConnectionTemplates.createdAt);
  }

  /**
   * Adds a `not_submitted` row for each template the connection does not have
   * yet. Existing rows are left as they are, so two runs add each row once.
   */
  async ensureRows(
    orgId: string,
    connectionId: string,
    templates: readonly { templateId: string; metaLanguageCode: string }[],
  ): Promise<number> {
    if (templates.length === 0) return 0;
    try {
      const rows = await this.db
        .insert(whatsappConnectionTemplates)
        .values(
          templates.map((template) => ({
            orgId,
            connectionId,
            templateId: template.templateId,
            metaLanguageCode: template.metaLanguageCode,
          })),
        )
        .onConflictDoNothing({
          target: [
            whatsappConnectionTemplates.connectionId,
            whatsappConnectionTemplates.templateId,
          ],
        })
        .returning({ id: whatsappConnectionTemplates.id });
      return rows.length;
    } catch (error) {
      if (
        databaseErrorCode(error) === '23503' &&
        violatedConstraint(error) === CONNECTION_FKEY
      )
        return 0;
      throw error;
    }
  }

  /**
   * Takes one template for a submission. Only a row that was never sent, or
   * failed and is due, can be taken: a row left `submitting` or `unresolved`
   * may exist at the provider and is reconciled from its list first. Null
   * when another worker holds it or it is not due.
   */
  async claimForSubmission(
    orgId: string,
    id: string,
    leaseMs: number,
  ): Promise<WhatsappConnectionTemplateRecord | null> {
    const [row] = await this.db
      .update(whatsappConnectionTemplates)
      .set({
        status: 'submitting',
        leaseUntil: sql`now() + ${leaseMs} * interval '1 millisecond'`,
        attempts: sql`${whatsappConnectionTemplates.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(whatsappConnectionTemplates.orgId, orgId),
          eq(whatsappConnectionTemplates.id, id),
          sql`${whatsappConnectionTemplates.status} IN ('not_submitted', 'failed', 'missing')`,
          sql`(${whatsappConnectionTemplates.nextAttemptAt} IS NULL OR ${whatsappConnectionTemplates.nextAttemptAt} <= now())`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * A status webhook as a hint: written only to the row holding that Meta
   * template, and only when it is newer than the last status applied. The
   * sync it triggers reads the list, which stays the truth.
   */
  async applyStatusHint(
    orgId: string,
    connectionId: string,
    hint: { metaTemplateId: string; status: string; occurredAt: string },
  ): Promise<boolean> {
    const rows = await this.db
      .update(whatsappConnectionTemplates)
      .set({
        status: hint.status,
        statusEventAt: hint.occurredAt,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(whatsappConnectionTemplates.orgId, orgId),
          eq(whatsappConnectionTemplates.connectionId, connectionId),
          eq(whatsappConnectionTemplates.metaTemplateId, hint.metaTemplateId),
          sql`(${whatsappConnectionTemplates.statusEventAt} IS NULL OR ${whatsappConnectionTemplates.statusEventAt} < ${hint.occurredAt})`,
        ),
      )
      .returning({ id: whatsappConnectionTemplates.id });
    return rows.length > 0;
  }

  /**
   * Writes the outcome of a submission or a sync to one row of this
   * organization. A submission outcome passes the attempt it claimed, so a
   * worker whose lease ran out cannot overwrite a newer result.
   */
  async updateForOrg(
    orgId: string,
    id: string,
    patch: WhatsappConnectionTemplatePatch,
    expectedAttempts?: number,
    observedAt?: string,
  ): Promise<WhatsappConnectionTemplateRecord | null> {
    const [row] = await this.db
      .update(whatsappConnectionTemplates)
      .set({
        ...patch,
        ...(patch.driftAt === 'now' && { driftAt: sql`now()` }),
        ...(patch.lastSyncedAt === 'now' && { lastSyncedAt: sql`now()` }),
        ...(patch.submittedAt === 'now' && { submittedAt: sql`now()` }),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(whatsappConnectionTemplates.orgId, orgId),
          eq(whatsappConnectionTemplates.id, id),
          ...(observedAt
            ? [
                sql`(${whatsappConnectionTemplates.statusEventAt} IS NULL OR ${whatsappConnectionTemplates.statusEventAt} <= ${observedAt})`,
              ]
            : []),
          ...(expectedAttempts === undefined
            ? []
            : [eq(whatsappConnectionTemplates.attempts, expectedAttempts)]),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Records a template on the organization's connection, or updates it. Null
   * when the connection is not this organization's: the composite foreign key
   * refuses the insert, and the update matches only this organization's row.
   */
  async saveForOrg(
    orgId: string,
    input: SaveWhatsappConnectionTemplateInput,
  ): Promise<WhatsappConnectionTemplateRecord | null> {
    const fields = {
      metaLanguageCode: input.metaLanguageCode,
      ...(input.metaTemplateId !== undefined && {
        metaTemplateId: input.metaTemplateId,
      }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.quality !== undefined && { quality: input.quality }),
      ...(input.rejectionReason !== undefined && {
        rejectionReason: input.rejectionReason,
      }),
      ...(input.submittedAt !== undefined && {
        submittedAt: input.submittedAt,
      }),
      ...(input.statusEventAt !== undefined && {
        statusEventAt: input.statusEventAt,
      }),
      ...(input.lastError !== undefined && { lastError: input.lastError }),
    };
    try {
      const [row] = await this.db
        .insert(whatsappConnectionTemplates)
        .values({
          orgId,
          connectionId: input.connectionId,
          templateId: input.templateId,
          ...fields,
        })
        .onConflictDoUpdate({
          target: [
            whatsappConnectionTemplates.connectionId,
            whatsappConnectionTemplates.templateId,
          ],
          set: { ...fields, updatedAt: sql`now()` },
          where: eq(whatsappConnectionTemplates.orgId, orgId),
        })
        .returning();
      return row ?? null;
    } catch (error) {
      if (
        databaseErrorCode(error) === '23503' &&
        violatedConstraint(error) === CONNECTION_FKEY
      )
        return null;
      throw error;
    }
  }
}
