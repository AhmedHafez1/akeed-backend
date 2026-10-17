import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, not } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { whatsappTemplates } from '../schema';
import type {
  ImageTwinTemplate,
  RegistryTemplate,
  TemplateVariable,
} from '../../../shared/messaging/template-registry.types';
import type {
  TemplateCategory,
  TemplateComponentsSnapshot,
  TemplateQuality,
  TemplateReviewStatus,
} from '../../../shared/messaging/template-provider.types';

import { IMAGE_TWIN_SUFFIX } from '../../../shared/messaging/image-twin.policy';

/**
 * The columns a registry read needs. Reads filter on `header_format`
 * (migration 0066) so that image-header twins never reach selection.
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

/** Rows a store can choose and send as they are: not image twins. */
const TEXT_TEMPLATES = eq(whatsappTemplates.headerFormat, 'none');

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

  /**
   * Every text template, inactive ones included, in display order. Image
   * twins are read only by `findImageTwins`.
   */
  async findAll(): Promise<RegistryTemplate[]> {
    const rows = await this.db
      .select(REGISTRY_COLUMNS)
      .from(whatsappTemplates)
      .where(TEXT_TEMPLATES)
      .orderBy(
        asc(whatsappTemplates.purpose),
        asc(whatsappTemplates.language),
        asc(whatsappTemplates.sortOrder),
        asc(whatsappTemplates.key),
      );
    return rows.map(toRegistryTemplate);
  }

  /**
   * The keys of the templates staff retired for good. Not part of `findAll`:
   * it reads a column migration 0058 added, and the send path reads only
   * what 0054 created.
   */
  async findRetiredKeys(): Promise<string[]> {
    const rows = await this.db
      .select({ key: whatsappTemplates.key })
      .from(whatsappTemplates)
      .where(isNotNull(whatsappTemplates.retiredAt));
    return rows.map((row) => row.key);
  }

  /**
   * Every template with its provider-side values, for the staff pages. Unlike
   * `findAll` it reads columns migration 0057 added, so no send path uses it.
   */
  async findAllForInspection(): Promise<InspectedTemplate[]> {
    const rows = await this.db
      .select(INSPECTION_COLUMNS)
      .from(whatsappTemplates)
      .where(TEXT_TEMPLATES)
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

  /**
   * The image-header twins, inactive ones included. Sent only in place of
   * their text template, never chosen on their own.
   */
  async findImageTwins(): Promise<ImageTwinTemplate[]> {
    const parent = alias(whatsappTemplates, 'parent');
    const rows = await this.db
      .select({
        imageTwinOfKey: parent.key,
        parentTemplateName: parent.metaTemplateName,
        parentLanguageCode: parent.metaLanguageCode,
        templateName: whatsappTemplates.metaTemplateName,
        languageCode: whatsappTemplates.metaLanguageCode,
        isActive: whatsappTemplates.isActive,
        reviewStatus: whatsappTemplates.reviewStatus,
      })
      .from(whatsappTemplates)
      .innerJoin(parent, eq(parent.key, whatsappTemplates.imageTwinOfKey))
      .where(
        and(
          eq(whatsappTemplates.headerFormat, 'image'),
          eq(parent.headerFormat, 'none'),
        ),
      )
      .orderBy(asc(whatsappTemplates.key));
    return rows.map((row) => ({
      imageTwinOfKey: row.imageTwinOfKey,
      twinOf: {
        templateName: row.parentTemplateName,
        languageCode: row.parentLanguageCode,
      },
      templateName: row.templateName,
      languageCode: row.languageCode,
      isActive: row.isActive,
      reviewStatus: row.reviewStatus as TemplateReviewStatus | null,
    }));
  }

  /**
   * Registers the provider's twin of a text template, inactive. Everything
   * but the name, the provider's ID, status and category is copied from the
   * parent, so the twin fills exactly as the parent does. A parent that
   * already has a twin keeps it.
   */
  async registerImageTwin(
    parentKey: string,
    twin: {
      templateName: string;
      providerTemplateId: string | null;
      reviewStatus: TemplateReviewStatus | null;
      category: TemplateCategory | null;
    },
  ): Promise<'registered' | 'already_registered' | 'parent_missing'> {
    return this.db.transaction(async (tx) => {
      const [parent] = await tx
        .select()
        .from(whatsappTemplates)
        .where(
          and(
            eq(whatsappTemplates.key, parentKey),
            eq(whatsappTemplates.headerFormat, 'none'),
          ),
        )
        .limit(1)
        .for('update');
      if (!parent) return 'parent_missing';
      const inserted = await tx
        .insert(whatsappTemplates)
        .values({
          key: `${parent.key}${IMAGE_TWIN_SUFFIX}`,
          purpose: parent.purpose,
          language: parent.language,
          style: `${parent.style}${IMAGE_TWIN_SUFFIX}`,
          metaTemplateName: twin.templateName,
          metaLanguageCode: parent.metaLanguageCode,
          parameterFormat: parent.parameterFormat,
          variableMapping: parent.variableMapping,
          preview: parent.preview,
          metaTemplateId: twin.providerTemplateId,
          reviewStatus: twin.reviewStatus,
          category: twin.category,
          isActive: false,
          isDefault: false,
          sortOrder: parent.sortOrder,
          headerFormat: 'image',
          imageTwinOfKey: parent.key,
        })
        .onConflictDoNothing()
        .returning({ id: whatsappTemplates.id });
      return inserted.length > 0 ? 'registered' : 'already_registered';
    });
  }

  /**
   * Switches on every inactive twin the provider has approved, as the last
   * sync or template webhook recorded it. Returns the keys switched on.
   */
  async activateApprovedImageTwins(): Promise<string[]> {
    const rows = await this.db
      .update(whatsappTemplates)
      .set({ isActive: true, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(whatsappTemplates.headerFormat, 'image'),
          eq(whatsappTemplates.reviewStatus, 'approved'),
          not(whatsappTemplates.isActive),
        ),
      )
      .returning({ key: whatsappTemplates.key });
    return rows.map((row) => row.key).sort();
  }
}
