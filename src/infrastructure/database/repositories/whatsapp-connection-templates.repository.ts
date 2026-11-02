import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { whatsappConnectionTemplates } from '../schema';
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

const CONNECTION_FKEY = 'whatsapp_connection_templates_connection_fkey';

@Injectable()
export class WhatsappConnectionTemplatesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listForOrg(orgId: string): Promise<WhatsappConnectionTemplateRecord[]> {
    return this.db
      .select()
      .from(whatsappConnectionTemplates)
      .where(eq(whatsappConnectionTemplates.orgId, orgId))
      .orderBy(whatsappConnectionTemplates.createdAt);
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
