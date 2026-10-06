import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  integrations,
  whatsappTemplateDrafts,
  whatsappTemplateEdits,
  whatsappTemplates,
} from '../schema';
import { withSerializableRetry } from '../../../shared/database/serializable-retry';
import type { TemplateDraftVariable } from '../../../shared/messaging/template-draft.types';
import { isLegacyVariant } from '../../../shared/messaging/template-legacy-variants';
import {
  EDIT_DAY_WINDOW_MS,
  EDIT_MONTH_WINDOW_MS,
  decideEdit,
  decideLifecycle,
  isEligibleReplacement,
  needsReplacement,
  type LifecycleTemplate,
  type TemplateEditRefusal,
  type TemplateLifecycleAction,
  type TemplateLifecycleRefusal,
} from '../../../shared/messaging/template-lifecycle.policy';
import type { TemplateReviewStatus } from '../../../shared/messaging/template-provider.types';
import { COD_REMINDER_PURPOSE } from '../../../shared/messaging/template-registry.types';
import {
  insertTemplateAudit,
  toPreview,
  toVariableMapping,
  type TemplateAuditEntry,
  type TemplateDraftPatch,
  type TemplateDraftRow,
  type TemplateWriter,
} from './whatsapp-template-drafts.repository';
import {
  STORE_AR_KEY,
  STORE_EN_KEY,
} from './whatsapp-template-sync.repository';

const LIFECYCLE_COLUMNS = {
  id: whatsappTemplates.id,
  key: whatsappTemplates.key,
  purpose: whatsappTemplates.purpose,
  language: whatsappTemplates.language,
  style: whatsappTemplates.style,
  templateName: whatsappTemplates.metaTemplateName,
  isActive: whatsappTemplates.isActive,
  isDefault: whatsappTemplates.isDefault,
  reviewStatus: whatsappTemplates.reviewStatus,
  retiredAt: whatsappTemplates.retiredAt,
  providerTemplateId: whatsappTemplates.metaTemplateId,
  rejectionReason: whatsappTemplates.rejectionReason,
};

export interface LifecycleRow extends LifecycleTemplate {
  style: string;
  templateName: string;
  providerTemplateId: string | null;
  rejectionReason: string | null;
}

function toLifecycleRow(row: {
  [K in keyof typeof LIFECYCLE_COLUMNS]: unknown;
}): LifecycleRow {
  return {
    ...(row as unknown as LifecycleRow),
    reviewStatus: row.reviewStatus as TemplateReviewStatus | null,
  };
}

interface TemplateFlags {
  is_active: boolean;
  is_default: boolean;
  retired: boolean;
}

function flagsOf(row: LifecycleTemplate): TemplateFlags {
  return {
    is_active: row.isActive,
    is_default: row.isDefault,
    retired: row.retiredAt !== null,
  };
}

export type LifecycleOutcome =
  | { kind: 'not_found' }
  | { kind: 'replacement_not_found' }
  | { kind: 'refused'; reason: TemplateLifecycleRefusal }
  | {
      kind: 'applied';
      changed: boolean;
      before: TemplateFlags;
      after: TemplateFlags;
      replacementKey: string | null;
      movedStores: number;
    };

export interface TemplateImpact {
  template: LifecycleRow;
  /** Stores that select the template, and how many of them are active. */
  stores: { total: number; active: number };
  requiresReplacement: boolean;
  replacements: LifecycleRow[];
  edit: {
    draftId: string | null;
    editsLastDay: number;
    editsLast30Days: number;
    decision: ReturnType<typeof decideEdit>;
  };
}

export type EditStart =
  | { kind: 'not_found' }
  | { kind: 'refused'; reason: TemplateEditRefusal; rule: string }
  | {
      kind: 'started';
      editId: string;
      template: LifecycleRow;
      draft: TemplateDraftRow;
    };

/**
 * The store column that names a template of this purpose and language. A
 * reminder (US-08-07a) has its own columns and no old variant column.
 */
function storeKeyOf(template: Pick<LifecycleTemplate, 'purpose' | 'language'>) {
  if (template.purpose === COD_REMINDER_PURPOSE) {
    return template.language === 'ar'
      ? sql<string>`${integrations.codReminderArKey}`
      : sql<string>`${integrations.codReminderEnKey}`;
  }
  return template.language === 'ar' ? STORE_AR_KEY : STORE_EN_KEY;
}

/**
 * Staff writes on registry templates (US-08-06): activate, deactivate, set
 * default, retire and edit.
 *
 * Every action locks all templates of the target's purpose and language, in
 * key order, before it reads anything it decides on. Two actions on one
 * purpose and language therefore run one after the other, and template
 * webhooks, which lock rows in the same order, cannot deadlock with them.
 * The flags, the store move and the audit row are one transaction.
 */
@Injectable()
export class WhatsappTemplateLifecycleRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: DrizzleDB,
  ) {}

  async applyLifecycle(input: {
    key: string;
    action: TemplateLifecycleAction;
    replacementKey?: string;
    audit: Omit<TemplateAuditEntry, 'metadata'>;
  }): Promise<LifecycleOutcome> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx): Promise<LifecycleOutcome> => {
        const scope = await this.lockScope(tx, input.key);
        const target = scope.find((row) => row.key === input.key);
        if (!target) return { kind: 'not_found' };
        const replacement = input.replacementKey
          ? (scope.find((row) => row.key === input.replacementKey) ?? null)
          : null;
        if (input.replacementKey && !replacement) {
          return { kind: 'replacement_not_found' };
        }
        const storeCount = (await this.countStores(tx, target)).total;
        const decision = decideLifecycle({
          action: input.action,
          target,
          scope,
          replacement,
          storeCount,
        });
        if (!decision.ok) return { kind: 'refused', reason: decision.reason };

        const now = new Date().toISOString();
        const movedStores = decision.moveStoresTo
          ? await this.moveStores(tx, target, replacement!, now)
          : 0;
        for (const change of decision.changes) {
          await tx
            .update(whatsappTemplates)
            .set({
              ...(change.isActive !== undefined
                ? { isActive: change.isActive }
                : {}),
              ...(change.isDefault !== undefined
                ? { isDefault: change.isDefault }
                : {}),
              ...(change.retired ? { retiredAt: now } : {}),
              updatedAt: now,
            })
            .where(eq(whatsappTemplates.id, change.id));
        }
        const own = decision.changes.find((change) => change.id === target.id);
        const after: TemplateFlags = {
          is_active: own?.isActive ?? target.isActive,
          is_default: own?.isDefault ?? target.isDefault,
          retired: own?.retired === true || target.retiredAt !== null,
        };
        await insertTemplateAudit(tx, {
          ...input.audit,
          metadata: {
            templateKey: target.key,
            before: flagsOf(target),
            after,
            replacementKey: decision.moveStoresTo?.key ?? null,
            movedStores,
            changedKeys: decision.changes
              .map((change) => scope.find((row) => row.id === change.id)?.key)
              .sort(),
          },
        });
        return {
          kind: 'applied',
          changed: decision.changes.length > 0 || movedStores > 0,
          before: flagsOf(target),
          after,
          replacementKey: decision.moveStoresTo?.key ?? null,
          movedStores,
        };
      }),
    );
  }

  /** What an action on this template would touch. Reads only. */
  async impact(
    key: string,
    now: Date = new Date(),
  ): Promise<TemplateImpact | null> {
    const scope = await this.readScope(this.db, key, false);
    const template = scope.find((row) => row.key === key);
    if (!template) return null;
    const [stores, draft, edits] = await Promise.all([
      this.countStores(this.db, template),
      this.draftOf(this.db, template.id),
      this.countEdits(this.db, template.id, now),
    ]);
    return {
      template,
      stores,
      requiresReplacement: needsReplacement(template, stores.total),
      replacements: scope.filter((row) => isEligibleReplacement(template, row)),
      edit: {
        draftId: draft?.id ?? null,
        ...edits,
        decision: decideEdit({
          target: template,
          hasDraft: draft !== undefined,
          storeCount: stores.total,
          ...edits,
        }),
      },
    };
  }

  /**
   * Checks the edit rules under the lock and, when they pass, records the
   * edit as `unknown` before anything is sent. A second edit of an approved
   * template inside the window therefore sees the first and is refused.
   */
  async beginEdit(input: {
    key: string;
    userId: string;
    now?: Date;
  }): Promise<EditStart> {
    const now = input.now ?? new Date();
    return withSerializableRetry(() =>
      this.db.transaction(async (tx): Promise<EditStart> => {
        const scope = await this.lockScope(tx, input.key);
        const template = scope.find((row) => row.key === input.key);
        if (!template) return { kind: 'not_found' };
        const [stores, draft, edits] = await Promise.all([
          this.countStores(tx, template),
          this.draftOf(tx, template.id),
          this.countEdits(tx, template.id, now),
        ]);
        const decision = decideEdit({
          target: template,
          hasDraft: draft !== undefined,
          storeCount: stores.total,
          ...edits,
        });
        if (!decision.ok) {
          return {
            kind: 'refused',
            reason: decision.reason,
            rule: decision.rule,
          };
        }
        const [edit] = await tx
          .insert(whatsappTemplateEdits)
          .values({
            templateId: template.id,
            requestedBy: input.userId,
            requestedAt: now.toISOString(),
            outcome: 'unknown',
          })
          .returning({ id: whatsappTemplateEdits.id });
        return { kind: 'started', editId: edit.id, template, draft: draft! };
      }),
    );
  }

  /**
   * Records how an edit ended.
   *
   * - `applied`: the draft and the registry row take the new text, and the
   *   template reads `pending` until a sync or a webhook says otherwise
   *   (record 4.3.8).
   * - `unknown`: the provider may have applied it, so the template reads
   *   `pending` too and the edit still counts.
   * - `refused`: nothing changed and the edit does not count.
   */
  async finishEdit(
    input: {
      editId: string;
      templateId: string;
      draftId: string;
      outcome: 'applied' | 'refused' | 'unknown';
      providerReference?: string;
      content?: {
        patch: TemplateDraftPatch;
        variables: readonly TemplateDraftVariable[];
      };
    },
    audit: TemplateAuditEntry,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      await tx
        .update(whatsappTemplateEdits)
        .set({
          outcome: input.outcome,
          providerReference: input.providerReference ?? null,
        })
        .where(eq(whatsappTemplateEdits.id, input.editId));
      if (input.outcome !== 'refused') {
        const [draft] =
          input.outcome === 'applied' && input.content
            ? await tx
                .update(whatsappTemplateDrafts)
                .set({
                  body: input.content.patch.body,
                  confirmLabel: input.content.patch.confirmLabel,
                  cancelLabel: input.content.patch.cancelLabel,
                  samples: input.content.patch.samples,
                  updatedBy: audit.userId,
                  updatedAt: now,
                })
                .where(eq(whatsappTemplateDrafts.id, input.draftId))
                .returning()
            : [];
        await tx
          .update(whatsappTemplates)
          .set({
            reviewStatus: 'pending',
            rejectionReason: null,
            statusEventAt: now,
            updatedAt: now,
            ...(draft && input.content
              ? {
                  variableMapping: toVariableMapping(
                    draft.parameterFormat,
                    input.content.variables,
                  ),
                  preview: toPreview(draft),
                }
              : {}),
          })
          .where(eq(whatsappTemplates.id, input.templateId));
      }
      await insertTemplateAudit(tx, audit);
    });
  }

  /** Every template of the purpose and language `key` belongs to. */
  private async readScope(
    reader: Pick<DrizzleDB, 'select'>,
    key: string,
    lock: boolean,
  ): Promise<LifecycleRow[]> {
    const [target] = await reader
      .select({
        purpose: whatsappTemplates.purpose,
        language: whatsappTemplates.language,
      })
      .from(whatsappTemplates)
      .where(eq(whatsappTemplates.key, key))
      .limit(1);
    if (!target) return [];
    const query = reader
      .select(LIFECYCLE_COLUMNS)
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.purpose, target.purpose),
          eq(whatsappTemplates.language, target.language),
        ),
      )
      .orderBy(asc(whatsappTemplates.key));
    const rows = lock ? await query.for('update') : await query;
    return rows.map(toLifecycleRow);
  }

  private lockScope(tx: TemplateWriter, key: string): Promise<LifecycleRow[]> {
    return this.readScope(tx, key, true);
  }

  private async countStores(
    reader: Pick<DrizzleDB, 'select'>,
    template: LifecycleTemplate,
  ): Promise<{ total: number; active: number }> {
    const [row] = await reader
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) FILTER (WHERE ${integrations.isActive})::int`,
      })
      .from(integrations)
      .where(eq(storeKeyOf(template), template.key));
    return { total: Number(row?.total ?? 0), active: Number(row?.active ?? 0) };
  }

  /**
   * Points every store that selects `from` at `to`. A store with no stored
   * key is matched through its old variant column, like a send; the old
   * column follows only when the replacement is one of its values.
   */
  private async moveStores(
    tx: TemplateWriter,
    from: LifecycleRow,
    to: LifecycleRow,
    now: string,
  ): Promise<number> {
    const legacy =
      from.purpose !== COD_REMINDER_PURPOSE &&
      isLegacyVariant(from.language, to.style);
    const reminderColumn =
      from.language === 'ar' ? 'codReminderArKey' : 'codReminderEnKey';
    const moved = await tx
      .update(integrations)
      .set(
        from.purpose === COD_REMINDER_PURPOSE
          ? { [reminderColumn]: to.key, updatedAt: now }
          : from.language === 'ar'
            ? {
                codTemplateArKey: to.key,
                ...(legacy ? { codTemplateArVariant: to.style } : {}),
                updatedAt: now,
              }
            : {
                codTemplateEnKey: to.key,
                ...(legacy ? { codTemplateEnVariant: to.style } : {}),
                updatedAt: now,
              },
      )
      .where(eq(storeKeyOf(from), from.key))
      .returning({ id: integrations.id });
    return moved.length;
  }

  private async draftOf(
    reader: Pick<DrizzleDB, 'select'>,
    templateId: string,
  ): Promise<TemplateDraftRow | undefined> {
    const [draft] = await reader
      .select()
      .from(whatsappTemplateDrafts)
      .where(eq(whatsappTemplateDrafts.templateId, templateId))
      .limit(1);
    return draft;
  }

  /** Edits that count against the limits: applied, or not known to have failed. */
  private async countEdits(
    reader: Pick<DrizzleDB, 'select'>,
    templateId: string,
    now: Date,
  ): Promise<{ editsLastDay: number; editsLast30Days: number }> {
    const dayStart = new Date(now.getTime() - EDIT_DAY_WINDOW_MS).toISOString();
    const [row] = await reader
      .select({
        month: sql<number>`count(*)::int`,
        day: sql<number>`count(*) FILTER (WHERE ${whatsappTemplateEdits.requestedAt} > ${dayStart}::timestamptz)::int`,
      })
      .from(whatsappTemplateEdits)
      .where(
        and(
          eq(whatsappTemplateEdits.templateId, templateId),
          inArray(whatsappTemplateEdits.outcome, ['applied', 'unknown']),
          gte(
            whatsappTemplateEdits.requestedAt,
            new Date(now.getTime() - EDIT_MONTH_WINDOW_MS).toISOString(),
          ),
        ),
      );
    return {
      editsLastDay: Number(row?.day ?? 0),
      editsLast30Days: Number(row?.month ?? 0),
    };
  }
}
