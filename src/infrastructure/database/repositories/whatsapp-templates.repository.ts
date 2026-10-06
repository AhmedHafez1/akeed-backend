import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { whatsappTemplates } from '../schema';
import type {
  RegistryTemplate,
  TemplateVariable,
} from '../../../shared/messaging/template-registry.types';
import type {
  TemplateCategory,
  TemplateComponentsSnapshot,
  TemplateQuality,
  TemplateReviewStatus,
} from '../../../shared/messaging/template-provider.types';

/**
 * The columns a registry read needs. They all exist since migration 0054, so
 * the reader does not depend on a later migration having run.
 */
const REGISTRY_COLUMNS = {
  key: whatsappTemplates.key,
  purpose: whatsappTemplates.purpose,
  language: whatsappTemplates.language,
  style: whatsappTemplates.style,
  metaTemplateName: whatsappTemplates.metaTemplateName,
  metaLanguageCode: whatsappTemplates.metaLanguageCode,
  parameterFormat: whatsappTemplates.parameterFormat,
  variableMapping: whatsappTemplates.variableMapping,
  preview: whatsappTemplates.preview,
  isActive: whatsappTemplates.isActive,
  isDefault: whatsappTemplates.isDefault,
  reviewStatus: whatsappTemplates.reviewStatus,
  category: whatsappTemplates.category,
  lastSyncedAt: whatsappTemplates.lastSyncedAt,
  componentsSnapshot: whatsappTemplates.componentsSnapshot,
};

type WhatsappTemplateRow = Pick<
  typeof whatsappTemplates.$inferSelect,
  keyof typeof REGISTRY_COLUMNS
>;

/** What the staff template pages read on top of a registry row. */
const INSPECTION_COLUMNS = {
  ...REGISTRY_COLUMNS,
  id: whatsappTemplates.id,
  quality: whatsappTemplates.quality,
  pendingCategory: whatsappTemplates.pendingCategory,
  metaTemplateId: whatsappTemplates.metaTemplateId,
  componentsSnapshot: whatsappTemplates.componentsSnapshot,
  componentsDriftAt: whatsappTemplates.componentsDriftAt,
};

type WhatsappTemplateInspectionRow = Pick<
  typeof whatsappTemplates.$inferSelect,
  keyof typeof INSPECTION_COLUMNS
>;

/** A registry template with the provider-side values staff inspect. */
export interface InspectedTemplate {
  id: string;
  template: RegistryTemplate;
  quality: TemplateQuality | null;
  pendingCategory: TemplateCategory | null;
  providerTemplateId: string | null;
  components: TemplateComponentsSnapshot | null;
  /** When a sync last found the provider's text changed. */
  componentsDriftAt: string | null;
}

function toInspectedTemplate(
  row: WhatsappTemplateInspectionRow,
): InspectedTemplate {
  return {
    id: row.id,
    template: toRegistryTemplate(row),
    quality: row.quality as TemplateQuality | null,
    pendingCategory: row.pendingCategory as TemplateCategory | null,
    providerTemplateId: row.metaTemplateId,
    components: row.componentsSnapshot as TemplateComponentsSnapshot | null,
    componentsDriftAt: row.componentsDriftAt,
  };
}

/**
 * Turns the stored mapping into the variables in send order. A positional
 * template is ordered by its positions and carries no parameter names.
 */
function toVariables(row: WhatsappTemplateRow): TemplateVariable[] {
  if (row.parameterFormat === 'positional') {
    return [...row.variableMapping]
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
      .map(({ key }) => ({ key }));
  }
  return row.variableMapping.map(({ key, name }) => ({
    key,
    name: name ?? key,
  }));
}

export function toRegistryTemplate(row: WhatsappTemplateRow): RegistryTemplate {
  return {
    key: row.key,
    purpose: row.purpose,
    language: row.language,
    style: row.style,
    templateName: row.metaTemplateName,
    languageCode: row.metaLanguageCode,
    parameterFormat: row.parameterFormat,
    variables: toVariables(row),
    // jsonb does not keep key order; the response order is part of the
    // settings contract, so it is restated here.
    preview: {
      greeting: row.preview.greeting,
      body: row.preview.body,
      totalLabel: row.preview.totalLabel,
      ending: row.preview.ending,
      confirmButton: row.preview.confirmButton,
      cancelButton: row.preview.cancelButton,
    },
    isActive: row.isActive,
    isDefault: row.isDefault,
    // Only sync and template webhooks write these, and only neutral values.
    reviewStatus: row.reviewStatus as TemplateReviewStatus | null,
    category: row.category as TemplateCategory | null,
    lastSyncedAt: row.lastSyncedAt,
    // Only once a sync has stored one, so an unsynced row reads as before.
    ...(row.componentsSnapshot
      ? { components: row.componentsSnapshot as TemplateComponentsSnapshot }
      : {}),
  };
}

/**
 * The only reader of `whatsapp_templates`. The table is global: every
 * template belongs to the single Akeed sender, so there is no tenant scope.
 */
@Injectable()
export class WhatsappTemplatesRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: DrizzleDB,
  ) {}

  /** Every template, inactive ones included, in display order. */
  async findAll(): Promise<RegistryTemplate[]> {
    const rows = await this.db
      .select(REGISTRY_COLUMNS)
      .from(whatsappTemplates)
      .orderBy(
        asc(whatsappTemplates.purpose),
        asc(whatsappTemplates.language),
        asc(whatsappTemplates.sortOrder),
        asc(whatsappTemplates.key),
      );
    return rows.map(toRegistryTemplate);
  }

  /**
   * Every template with its provider-side values, for the staff pages. Unlike
   * `findAll` it reads columns migration 0057 added, so no send path uses it.
   */
  async findAllForInspection(): Promise<InspectedTemplate[]> {
    const rows = await this.db
      .select(INSPECTION_COLUMNS)
      .from(whatsappTemplates)
      .orderBy(
        asc(whatsappTemplates.purpose),
        asc(whatsappTemplates.language),
        asc(whatsappTemplates.sortOrder),
        asc(whatsappTemplates.key),
      );
    return rows.map(toInspectedTemplate);
  }

  async findForInspection(key: string): Promise<InspectedTemplate | undefined> {
    const [row] = await this.db
      .select(INSPECTION_COLUMNS)
      .from(whatsappTemplates)
      .where(eq(whatsappTemplates.key, key))
      .limit(1);
    return row ? toInspectedTemplate(row) : undefined;
  }
}
