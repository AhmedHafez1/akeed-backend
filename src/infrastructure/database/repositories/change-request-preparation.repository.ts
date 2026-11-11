import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { whatsappTemplates, whatsappTemplateDrafts } from '../schema';
import { insertTemplateAudit } from './whatsapp-template-drafts.repository';
import type { ChangePreparationPlan } from '../../../shared/messaging/change-request-preparation.policy';

@Injectable()
export class ChangeRequestPreparationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async inventory() {
    const [templates, drafts] = await Promise.all([
      this.db.select().from(whatsappTemplates),
      this.db.select().from(whatsappTemplateDrafts),
    ]);
    return { templates, drafts };
  }

  async prepare(
    plans: ChangePreparationPlan[],
    userId: string,
    requestId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(29160428)`);
      const results: {
        parent_key: string;
        outcome: string;
        draft_id?: string;
        reason?: string;
      }[] = [];
      for (const plan of plans) {
        const [parent] =
          plan.sourceKind === 'draft'
            ? await tx
                .select()
                .from(whatsappTemplateDrafts)
                .where(eq(whatsappTemplateDrafts.key, plan.parentKey))
                .for('update')
            : await tx
                .select()
                .from(whatsappTemplates)
                .where(eq(whatsappTemplates.key, plan.parentKey))
                .for('update');
        const existing = await tx
          .select()
          .from(whatsappTemplateDrafts)
          .where(eq(whatsappTemplateDrafts.changeRequestOfKey, plan.parentKey));
        if (existing.length > 1) {
          results.push({
            parent_key: plan.parentKey,
            outcome: 'blocked',
            reason: 'multiple_counterparts',
          });
          continue;
        }
        if (existing.length) {
          results.push({
            parent_key: plan.parentKey,
            outcome: 'reused',
            draft_id: existing[0].id,
          });
          continue;
        }
        const [registered] = await tx
          .select()
          .from(whatsappTemplates)
          .where(
            and(
              eq(whatsappTemplates.changeRequestOfKey, plan.parentKey),
              eq(whatsappTemplates.headerFormat, 'none'),
            ),
          )
          .limit(1);
        if (registered) {
          results.push({ parent_key: plan.parentKey, outcome: 'reused' });
          continue;
        }
        if (
          !parent ||
          parent.updatedAt !== plan.sourceUpdatedAt ||
          plan.issues.some((i) => i.severity === 'error')
        ) {
          results.push({
            parent_key: plan.parentKey,
            outcome: 'blocked',
            reason: 'source_changed_or_invalid',
          });
          continue;
        }
        const c = plan.content;
        const [draft] = await tx
          .insert(whatsappTemplateDrafts)
          .values({
            key: plan.key,
            purpose: c.purpose,
            language: c.language,
            style: c.style,
            version: c.version,
            metaTemplateName: c.templateName,
            metaLanguageCode: c.languageCode,
            parameterFormat: c.parameterFormat,
            category: c.category,
            body: c.body,
            confirmLabel: c.confirmLabel,
            cancelLabel: c.cancelLabel,
            changeLabel: c.changeLabel,
            changeRequestOfKey: plan.parentKey,
            samples: c.samples,
            createdBy: userId,
            updatedBy: userId,
          })
          .onConflictDoNothing()
          .returning({ id: whatsappTemplateDrafts.id });
        results.push({
          parent_key: plan.parentKey,
          outcome: draft ? 'created' : 'blocked',
          ...(draft ? { draft_id: draft.id } : { reason: 'identity_conflict' }),
        });
      }
      await insertTemplateAudit(tx, {
        userId,
        action: 'whatsapp-templates.change-requests.prepare',
        requestId,
        metadata: { results },
      });
      return { results };
    });
  }
}
