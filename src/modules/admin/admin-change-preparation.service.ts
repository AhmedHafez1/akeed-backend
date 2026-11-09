import { Inject, Injectable } from '@nestjs/common';
import type { TemplateComponentsSnapshot } from '../../shared/messaging/template-provider.types';
import { ChangeRequestPreparationRepository } from '../../infrastructure/database/repositories/change-request-preparation.repository';
import { toRegistryTemplate } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import { toDraftContent } from '../../infrastructure/database/repositories/whatsapp-template-drafts.repository';
import {
  TEMPLATE_CATALOG_PORT,
  type TemplateCatalogPort,
} from '../../shared/ports/template-catalog.port';
import {
  planChangeDraft,
  planDraftChange,
} from '../../shared/messaging/change-request-preparation.policy';
import { validateTemplateDraft } from '../../shared/messaging/template-draft.validation';
import type { TemplateDraftContent } from '../../shared/messaging/template-draft.types';

export interface PreparationVariant {
  parent_key: string;
  language: string;
  style: string;
  purpose: string;
  draft_id: string | null;
  key: string | null;
  content: TemplateDraftContent | null;
  state: string;
  review_status: string | null;
  active: boolean;
  differences: string[];
  validation: ReturnType<typeof validateTemplateDraft> | null;
  blocked_reason: string | null;
  image_twin: {
    key: string | null;
    template_name: string | null;
    state: string;
    review_status: string | null;
    active: boolean;
    header: string;
    parent_key: string | null;
  };
  merchant_own: { text: string; image: string };
}

@Injectable()
export class AdminChangePreparationService {
  constructor(
    private readonly repository: ChangeRequestPreparationRepository,
    @Inject(TEMPLATE_CATALOG_PORT)
    private readonly catalog: TemplateCatalogPort,
  ) {}

  async overview() {
    const { templates, drafts } = await this.repository.inventory();
    const parents = templates.filter(
      (t) => t.headerFormat === 'none' && !t.changeRequestOfKey && !t.retiredAt,
    );
    const variants = parents.map((parent): PreparationVariant => {
      const sourceDraft = drafts.find((d) => d.templateId === parent.id);
      const plan = planChangeDraft(
        toRegistryTemplate(parent),
        this.catalog.describeComponents(
          parent.componentsSnapshot as TemplateComponentsSnapshot | null,
        ),
        parent.updatedAt,
        sourceDraft?.samples,
      );
      const linked = drafts.filter((d) => d.changeRequestOfKey === parent.key);
      const counterpart = templates.find(
        (t) => t.headerFormat === 'none' && t.changeRequestOfKey === parent.key,
      );
      const draft = linked[0];
      const content = draft ? toDraftContent(draft) : (plan?.content ?? null);
      const key = draft?.key ?? counterpart?.key ?? plan?.key ?? null;
      const twin = templates.find((t) => t.imageTwinOfKey === key);
      return {
        parent_key: parent.key,
        language: parent.language,
        style: parent.style,
        purpose: parent.purpose,
        draft_id: draft?.id ?? null,
        key,
        content,
        state: draft?.state ?? (counterpart ? 'registered' : 'missing'),
        review_status: counterpart?.reviewStatus ?? null,
        active: counterpart?.isActive ?? false,
        differences: plan?.differences ?? [],
        validation: content
          ? validateTemplateDraft(content, { takenIdentities: new Set() })
          : null,
        blocked_reason:
          linked.length > 1
            ? 'multiple_counterparts'
            : !plan && !draft
              ? 'source_unreadable_or_unsupported'
              : null,
        image_twin: {
          key: twin?.key ?? (key ? `${key}_logo` : null),
          template_name:
            twin?.metaTemplateName ??
            (content ? `${content.templateName}_logo` : null),
          state: twin ? 'registered' : 'planned',
          review_status: twin?.reviewStatus ?? null,
          active: twin?.isActive ?? false,
          header: 'IMAGE',
          parent_key: key,
        },
        merchant_own: {
          text: 'independent_approval_required',
          image: 'unsupported',
        },
      };
    });
    // Unregistered ordinary drafts remain part of the same preparation inventory.
    const draftOnly = drafts
      .filter((d) => !d.templateId && !d.changeRequestOfKey)
      .map((d) => ({
        parent_key: d.key,
        language: d.language,
        style: d.style,
        purpose: d.purpose,
        state: 'source_draft',
        reason: 'review_source_draft',
      }));
    for (const source of drafts.filter(
      (d) => !d.templateId && !d.changeRequestOfKey,
    )) {
      const plan = planDraftChange(
        toDraftContent(source),
        source.key,
        source.updatedAt,
      );
      const draft = drafts.find((d) => d.changeRequestOfKey === source.key);
      const content = draft ? toDraftContent(draft) : (plan?.content ?? null);
      const key = draft?.key ?? plan?.key ?? null;
      variants.push({
        parent_key: source.key,
        language: source.language,
        style: source.style,
        purpose: source.purpose,
        draft_id: draft?.id ?? null,
        key,
        content,
        state: draft?.state ?? 'missing',
        review_status: null,
        active: false,
        differences: [],
        validation: content
          ? validateTemplateDraft(content, { takenIdentities: new Set() })
          : null,
        blocked_reason: plan ? null : 'source_unreadable_or_unsupported',
        image_twin: {
          key: key ? key + '_logo' : null,
          template_name: content ? content.templateName + '_logo' : null,
          state: 'planned',
          review_status: null,
          active: false,
          header: 'IMAGE',
          parent_key: key,
        },
        merchant_own: {
          text: 'independent_approval_required',
          image: 'unsupported',
        },
      });
    }
    return { variants, draft_only_sources: draftOnly };
  }

  async prepare(userId: string, requestId?: string) {
    const { templates, drafts } = await this.repository.inventory();
    const plans = templates
      .filter(
        (t) =>
          t.headerFormat === 'none' && !t.changeRequestOfKey && !t.retiredAt,
      )
      .flatMap((parent) => {
        const plan = planChangeDraft(
          toRegistryTemplate(parent),
          this.catalog.describeComponents(
            parent.componentsSnapshot as TemplateComponentsSnapshot | null,
          ),
          parent.updatedAt,
          drafts.find((d) => d.templateId === parent.id)?.samples,
        );
        return plan ? [plan] : [];
      });
    for (const source of drafts.filter(
      (d) => !d.templateId && !d.changeRequestOfKey,
    )) {
      const plan = planDraftChange(
        toDraftContent(source),
        source.key,
        source.updatedAt,
      );
      if (plan) plans.push(plan);
    }
    return this.repository.prepare(plans, userId, requestId);
  }
}
