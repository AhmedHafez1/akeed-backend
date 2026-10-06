import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  adminAccessAudit,
  whatsappTemplateDrafts,
  whatsappTemplates,
} from '../schema';
import {
  databaseErrorCode,
  withSerializableRetry,
} from '../../../shared/database/serializable-retry';
import type {
  TemplateDraftContent,
  TemplateDraftSamples,
  TemplateDraftVariable,
  TemplateSubmissionResult,
} from '../../../shared/messaging/template-draft.types';
import {
  buildDraftKey,
  buildTemplateName,
  draftIdentity,
  registryStyleOf,
} from '../../../shared/messaging/template-draft.validation';
import type { TemplateCategory } from '../../../shared/messaging/template-provider.types';
import type {
  TemplateLanguage,
  TemplateParameterFormat,
  TemplatePurpose,
} from '../../../shared/messaging/template-registry.types';

export type TemplateDraftRow = typeof whatsappTemplateDrafts.$inferSelect;

export type TemplateWriter = Parameters<
  Parameters<DrizzleDB['transaction']>[0]
>[0];

/** A staff template write to record, in the transaction that makes it. */
export interface TemplateAuditEntry {
  userId: string;
  action: string;
  requestId?: string;
  /** Keys, flags, counts and references only. Never template text. */
  metadata: Record<string, unknown>;
}

export async function insertTemplateAudit(
  writer: TemplateWriter,
  entry: TemplateAuditEntry,
): Promise<void> {
  await writer.insert(adminAccessAudit).values({
    userId: entry.userId,
    action: entry.action,
    outcome: 'allowed',
    requestId: entry.requestId,
    metadata: { version: 1, ...entry.metadata },
  });
}

/** A `submitting` claim older than this is taken to have died mid-flight. */
export const ABANDONED_SUBMIT_MS = 5 * 60_000;

/** Registry rows created from drafts sort after the seeded ones. */
const AUTHORED_SORT_ORDER = 100;

export interface NewTemplateDraft {
  purpose: TemplatePurpose;
  language: TemplateLanguage;
  style: string;
  languageCode: string;
  parameterFormat: TemplateParameterFormat;
  category: TemplateCategory;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  samples: TemplateDraftSamples;
}

export type TemplateDraftPatch = Partial<
  Pick<
    NewTemplateDraft,
    | 'languageCode'
    | 'parameterFormat'
    | 'body'
    | 'confirmLabel'
    | 'cancelLabel'
    | 'samples'
  >
>;

export type DraftClaim =
  | { kind: 'not_found' }
  | { kind: 'claimed'; draft: TemplateDraftRow }
  | { kind: 'already_submitted'; draft: TemplateDraftRow }
  | { kind: 'in_progress' }
  | { kind: 'unresolved' };

export function toDraftContent(row: TemplateDraftRow): TemplateDraftContent {
  return {
    purpose: row.purpose,
    language: row.language,
    style: row.style,
    version: row.version,
    templateName: row.metaTemplateName,
    languageCode: row.metaLanguageCode,
    parameterFormat: row.parameterFormat,
    category: row.category as TemplateCategory,
    body: row.body,
    confirmLabel: row.confirmLabel,
    cancelLabel: row.cancelLabel,
    samples: row.samples,
  };
}

/** A `submitting` draft whose submit died reads as `submit_unknown`. */
export function effectiveDraftState(
  row: Pick<TemplateDraftRow, 'state' | 'stateChangedAt'>,
  now: Date = new Date(),
): TemplateDraftRow['state'] {
  return row.state === 'submitting' &&
    now.getTime() - Date.parse(row.stateChangedAt) > ABANDONED_SUBMIT_MS
    ? 'submit_unknown'
    : row.state;
}

/**
 * Staff template drafts (US-08-06). Every write records its audit row in the
 * same transaction. Like the registry, drafts are global: every template
 * belongs to Akeed's one sender.
 */
@Injectable()
export class WhatsappTemplateDraftsRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: DrizzleDB,
  ) {}

  async list(limit: number): Promise<TemplateDraftRow[]> {
    return this.db
      .select()
      .from(whatsappTemplateDrafts)
      .orderBy(desc(whatsappTemplateDrafts.updatedAt))
      .limit(limit);
  }

  async findById(id: string): Promise<TemplateDraftRow | undefined> {
    const [row] = await this.db
      .select()
      .from(whatsappTemplateDrafts)
      .where(eq(whatsappTemplateDrafts.id, id))
      .limit(1);
    return row;
  }

  async findByTemplateId(
    templateId: string,
  ): Promise<TemplateDraftRow | undefined> {
    const [row] = await this.db
      .select()
      .from(whatsappTemplateDrafts)
      .where(eq(whatsappTemplateDrafts.templateId, templateId))
      .limit(1);
    return row;
  }

  /**
   * Every provider name and language already spoken for: registry rows and
   * the other drafts. A new draft may not reuse one (record 4.4.3).
   */
  async takenIdentities(exceptDraftId?: string): Promise<Set<string>> {
    const [templates, drafts] = await Promise.all([
      this.db
        .select({
          name: whatsappTemplates.metaTemplateName,
          code: whatsappTemplates.metaLanguageCode,
          id: whatsappTemplates.id,
        })
        .from(whatsappTemplates),
      this.db
        .select({
          name: whatsappTemplateDrafts.metaTemplateName,
          code: whatsappTemplateDrafts.metaLanguageCode,
          templateId: whatsappTemplateDrafts.templateId,
        })
        .from(whatsappTemplateDrafts)
        .where(
          exceptDraftId
            ? ne(whatsappTemplateDrafts.id, exceptDraftId)
            : undefined,
        ),
    ]);
    const own = exceptDraftId
      ? (await this.findById(exceptDraftId))?.templateId
      : null;
    return new Set([
      ...templates
        .filter((row) => row.id !== own)
        .map((row) => draftIdentity(row.name, row.code)),
      ...drafts.map((row) => draftIdentity(row.name, row.code)),
    ]);
  }

  /** The version a new draft of this purpose, language and style would get. */
  async nextVersion(
    purpose: TemplatePurpose,
    language: TemplateLanguage,
    style: string,
    reader: Pick<DrizzleDB, 'select'> = this.db,
  ): Promise<number> {
    const [row] = await reader
      .select({
        latest: sql<number>`COALESCE(MAX(${whatsappTemplateDrafts.version}), 0)::int`,
      })
      .from(whatsappTemplateDrafts)
      .where(
        and(
          eq(whatsappTemplateDrafts.purpose, purpose),
          eq(whatsappTemplateDrafts.language, language),
          eq(whatsappTemplateDrafts.style, style),
        ),
      );
    return Number(row?.latest ?? 0) + 1;
  }

  /**
   * Inserts a draft under the next version of its style. NULL when another
   * draft took the same name first: the caller reports a conflict.
   */
  async create(
    input: NewTemplateDraft,
    audit: Omit<TemplateAuditEntry, 'metadata'>,
  ): Promise<TemplateDraftRow | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const version = await this.nextVersion(
          input.purpose,
          input.language,
          input.style,
          tx,
        );
        const [row] = await tx
          .insert(whatsappTemplateDrafts)
          .values({
            key: buildDraftKey(
              input.purpose,
              input.language,
              input.style,
              version,
            ),
            purpose: input.purpose,
            language: input.language,
            style: input.style,
            version,
            metaTemplateName: buildTemplateName(
              input.purpose,
              input.style,
              version,
            ),
            metaLanguageCode: input.languageCode,
            parameterFormat: input.parameterFormat,
            category: input.category,
            body: input.body,
            confirmLabel: input.confirmLabel,
            cancelLabel: input.cancelLabel,
            samples: input.samples,
            createdBy: audit.userId,
            updatedBy: audit.userId,
          })
          .returning();
        await insertTemplateAudit(tx, {
          ...audit,
          metadata: { draftId: row.id, templateKey: row.key },
        });
        return row;
      });
    } catch (error) {
      if (databaseErrorCode(error) === '23505') return null;
      throw error;
    }
  }

  /** Changes a draft that is still a draft. */
  async update(
    id: string,
    patch: TemplateDraftPatch,
    audit: Omit<TemplateAuditEntry, 'metadata'>,
  ): Promise<
    | { kind: 'not_found' }
    | { kind: 'not_editable' }
    | { kind: 'name_taken' }
    | { kind: 'updated'; draft: TemplateDraftRow }
  > {
    try {
      return await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(whatsappTemplateDrafts)
          .where(eq(whatsappTemplateDrafts.id, id))
          .for('update');
        if (!current) return { kind: 'not_found' as const };
        if (current.state !== 'draft') return { kind: 'not_editable' as const };
        const now = new Date().toISOString();
        const [draft] = await tx
          .update(whatsappTemplateDrafts)
          .set({
            ...(patch.languageCode !== undefined
              ? { metaLanguageCode: patch.languageCode }
              : {}),
            ...(patch.parameterFormat !== undefined
              ? { parameterFormat: patch.parameterFormat }
              : {}),
            ...(patch.body !== undefined ? { body: patch.body } : {}),
            ...(patch.confirmLabel !== undefined
              ? { confirmLabel: patch.confirmLabel }
              : {}),
            ...(patch.cancelLabel !== undefined
              ? { cancelLabel: patch.cancelLabel }
              : {}),
            ...(patch.samples !== undefined ? { samples: patch.samples } : {}),
            updatedBy: audit.userId,
            updatedAt: now,
          })
          .where(eq(whatsappTemplateDrafts.id, id))
          .returning();
        await insertTemplateAudit(tx, {
          ...audit,
          metadata: {
            draftId: id,
            templateKey: draft.key,
            changed: Object.keys(patch).sort(),
          },
        });
        return { kind: 'updated' as const, draft };
      });
    } catch (error) {
      if (databaseErrorCode(error) === '23505') return { kind: 'name_taken' };
      throw error;
    }
  }

  /** Deletes a draft the provider never saw. Nothing is deleted there. */
  async discard(
    id: string,
    audit: Omit<TemplateAuditEntry, 'metadata'>,
  ): Promise<'not_found' | 'not_editable' | 'discarded'> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(whatsappTemplateDrafts)
        .where(eq(whatsappTemplateDrafts.id, id))
        .for('update');
      if (!current) return 'not_found';
      if (current.state !== 'draft' || current.templateId) {
        return 'not_editable';
      }
      await tx
        .delete(whatsappTemplateDrafts)
        .where(eq(whatsappTemplateDrafts.id, id));
      await insertTemplateAudit(tx, {
        ...audit,
        metadata: { draftId: id, templateKey: current.key },
      });
      return 'discarded';
    });
  }

  /**
   * Takes the draft for one submit. Only a `draft` can be claimed, so two
   * submits at once send one request: the second sees `in_progress`. A draft
   * whose last submit got no answer is `unresolved` until it is reconciled.
   */
  async claimForSubmit(
    id: string,
    now: Date = new Date(),
  ): Promise<DraftClaim> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(whatsappTemplateDrafts)
        .where(eq(whatsappTemplateDrafts.id, id))
        .for('update');
      if (!current) return { kind: 'not_found' as const };
      const state = effectiveDraftState(current, now);
      if (state === 'submitted') {
        return { kind: 'already_submitted' as const, draft: current };
      }
      if (state === 'submitting') return { kind: 'in_progress' as const };
      if (state === 'submit_unknown') return { kind: 'unresolved' as const };
      const [draft] = await tx
        .update(whatsappTemplateDrafts)
        .set({ state: 'submitting', stateChangedAt: now.toISOString() })
        .where(eq(whatsappTemplateDrafts.id, id))
        .returning();
      return { kind: 'claimed' as const, draft };
    });
  }

  /**
   * Takes a draft whose submit got no answer, to check the provider. NULL
   * when the draft is in any other state.
   */
  async claimForReconcile(
    id: string,
    now: Date = new Date(),
  ): Promise<TemplateDraftRow | null | undefined> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(whatsappTemplateDrafts)
        .where(eq(whatsappTemplateDrafts.id, id))
        .for('update');
      if (!current) return undefined;
      if (effectiveDraftState(current, now) !== 'submit_unknown') return null;
      const [draft] = await tx
        .update(whatsappTemplateDrafts)
        .set({ state: 'submitting', stateChangedAt: now.toISOString() })
        .where(eq(whatsappTemplateDrafts.id, id))
        .returning();
      return draft;
    });
  }

  /** Ends a claim without a template: back to `draft`, or `submit_unknown`. */
  async closeClaim(
    id: string,
    next: {
      state: 'draft' | 'submit_unknown';
      errorCode: string | null;
      providerReference?: string;
    },
    audit: TemplateAuditEntry,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(whatsappTemplateDrafts)
        .set({
          state: next.state,
          stateChangedAt: new Date().toISOString(),
          lastErrorCode: next.errorCode,
          lastProviderReference: next.providerReference ?? null,
        })
        .where(
          and(
            eq(whatsappTemplateDrafts.id, id),
            eq(whatsappTemplateDrafts.state, 'submitting'),
          ),
        );
      await insertTemplateAudit(tx, audit);
    });
  }

  /**
   * The provider holds the template: inserts its registry row, inactive and
   * not a default, and links the draft to it, in one transaction. Replaying
   * it for a draft already linked changes nothing.
   */
  async confirmSubmission(
    id: string,
    params: {
      result: TemplateSubmissionResult;
      variables: readonly TemplateDraftVariable[];
    },
    audit: TemplateAuditEntry,
  ): Promise<{ draft: TemplateDraftRow; templateKey: string }> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(whatsappTemplateDrafts)
          .where(eq(whatsappTemplateDrafts.id, id))
          .for('update');
        if (current.state === 'submitted') {
          return { draft: current, templateKey: current.key };
        }
        const now = new Date().toISOString();
        const [template] = await tx
          .insert(whatsappTemplates)
          .values({
            key: current.key,
            purpose: current.purpose,
            language: current.language,
            style: registryStyleOf(current.style, current.version),
            metaTemplateName: current.metaTemplateName,
            metaLanguageCode: current.metaLanguageCode,
            parameterFormat: current.parameterFormat,
            variableMapping: toVariableMapping(
              current.parameterFormat,
              params.variables,
            ),
            preview: toPreview(current),
            metaTemplateId: params.result.providerTemplateId,
            reviewStatus: params.result.status,
            category: params.result.category,
            isActive: false,
            isDefault: false,
            sortOrder: AUTHORED_SORT_ORDER,
          })
          .returning({ id: whatsappTemplates.id });
        const [draft] = await tx
          .update(whatsappTemplateDrafts)
          .set({
            state: 'submitted',
            stateChangedAt: now,
            templateId: template.id,
            lastErrorCode: null,
            lastProviderReference: params.result.providerTemplateId,
            updatedAt: now,
          })
          .where(eq(whatsappTemplateDrafts.id, id))
          .returning();
        await insertTemplateAudit(tx, audit);
        return { draft, templateKey: current.key };
      }),
    );
  }
}

export function toVariableMapping(
  format: TemplateParameterFormat,
  variables: readonly TemplateDraftVariable[],
) {
  return variables.map((variable, index) =>
    format === 'named'
      ? { key: variable.key, name: variable.parameter }
      : { key: variable.key, position: index + 1 },
  );
}

/**
 * The preview merchants see in Settings. The draft body already uses the
 * placeholders that preview is filled from, so it is the one block.
 */
export function toPreview(
  draft: Pick<TemplateDraftRow, 'body' | 'confirmLabel' | 'cancelLabel'>,
) {
  return {
    greeting: '',
    body: draft.body,
    totalLabel: '',
    ending: '',
    confirmButton: draft.confirmLabel,
    cancelButton: draft.cancelLabel,
  };
}
