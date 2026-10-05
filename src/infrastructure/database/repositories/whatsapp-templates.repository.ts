import { Inject, Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { whatsappTemplates } from '../schema';
import type {
  RegistryTemplate,
  TemplateVariable,
} from '../../../shared/messaging/template-registry.types';

type WhatsappTemplateRow = typeof whatsappTemplates.$inferSelect;

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
      .select()
      .from(whatsappTemplates)
      .orderBy(
        asc(whatsappTemplates.purpose),
        asc(whatsappTemplates.language),
        asc(whatsappTemplates.sortOrder),
        asc(whatsappTemplates.key),
      );
    return rows.map(toRegistryTemplate);
  }
}
