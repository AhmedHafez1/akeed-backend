import type { TemplateRegistryPort } from '../../ports/template-registry.port';
import {
  COD_TEMPLATE_DEFAULTS,
  getAvailableCodTemplateDefinitions,
} from '../cod-template-catalog';
import {
  COD_CONFIRMATION_PURPOSE,
  buildCodConfirmationKey,
  type RegistryTemplate,
} from '../template-registry.types';

/** The languages migration 0054 seeded; the others have no seeded row. */
const CATALOG_LANGUAGES = ['ar', 'en'] as const;

/**
 * The registry as migration 0054 seeds it, built from the code catalog. For
 * specs only: the catalog file is the seed source and the characterization
 * baseline, and nothing at runtime reads it.
 */
export function seededRegistryTemplates(): RegistryTemplate[] {
  const definitions = getAvailableCodTemplateDefinitions();
  return CATALOG_LANGUAGES.flatMap((language) =>
    definitions[language].map(
      (definition): RegistryTemplate => ({
        key: buildCodConfirmationKey(language, definition.variant),
        purpose: COD_CONFIRMATION_PURPOSE,
        language,
        style: definition.variant,
        templateName: definition.metaTemplateName,
        languageCode: definition.metaLanguageCode,
        parameterFormat: definition.bodyVariableMode,
        variables: definition.bodyParameterOrder.map((key) =>
          definition.bodyVariableMode === 'named'
            ? { key, name: key }
            : { key },
        ),
        preview: { ...definition.preview },
        isActive: true,
        isDefault: COD_TEMPLATE_DEFAULTS[language] === definition.variant,
        reviewStatus: null,
        category: null,
        lastSyncedAt: null,
      }),
    ),
  );
}

/** An in-memory registry port over the given rows (the seed by default). */
export function seededTemplateRegistry(
  templates: readonly RegistryTemplate[] = seededRegistryTemplates(),
  options: { guardrail?: boolean; retiredKeys?: readonly string[] } = {},
): TemplateRegistryPort {
  return {
    listTemplates: () => Promise.resolve(templates),
    invalidate: () => undefined,
    sendGuardrailEnabled: () => options.guardrail === true,
    retiredTemplateKeys: () => Promise.resolve(options.retiredKeys ?? []),
  };
}

/** The seed as an environment that has synced and found every row approved. */
export function syncedApprovedTemplates(
  templates: readonly RegistryTemplate[] = seededRegistryTemplates(),
  syncedAt = '2026-10-05T00:00:00.000Z',
): RegistryTemplate[] {
  return templates.map((template) => ({
    ...template,
    reviewStatus: 'approved',
    category: 'utility',
    lastSyncedAt: syncedAt,
  }));
}

/**
 * A staff-written reminder as staff authoring registers it:
 * versioned style, `akeed_cod_reminder_<style>_v<n>`, approved and active.
 */
export function reminderTemplate(
  language: RegistryTemplate['language'],
  style: string,
  change: Partial<RegistryTemplate> = {},
): RegistryTemplate {
  return {
    key: `cod_reminder.${language}.${style}`,
    purpose: 'cod_reminder',
    language,
    style,
    templateName: `akeed_cod_reminder_${style}`,
    languageCode: language,
    parameterFormat: 'named',
    variables: [
      { key: 'customer', name: 'customer' },
      { key: 'order', name: 'order' },
      { key: 'store', name: 'store' },
      { key: 'total', name: 'total' },
    ],
    preview: {
      greeting: '',
      body: 'Reminder {{order}}',
      totalLabel: '',
      ending: '',
      confirmButton: 'Confirm',
      cancelButton: 'Cancel',
    },
    isActive: true,
    isDefault: false,
    reviewStatus: 'approved',
    category: 'utility',
    lastSyncedAt: null,
    ...change,
  };
}

/**
 * A confirmation as staff authoring registers it once the provider confirmed
 * the submit: versioned style, inactive, not a default, still in review.
 */
export function authoredTemplate(
  language: RegistryTemplate['language'],
  style: string,
  change: Partial<RegistryTemplate> = {},
): RegistryTemplate {
  return {
    key: buildCodConfirmationKey(language, style),
    purpose: COD_CONFIRMATION_PURPOSE,
    language,
    style,
    templateName: `akeed_cod_confirm_${style}`,
    languageCode: language,
    parameterFormat: 'named',
    variables: [
      { key: 'customer', name: 'customer' },
      { key: 'store', name: 'store' },
      { key: 'order', name: 'order' },
      { key: 'total', name: 'total' },
    ],
    preview: {
      greeting: '',
      body: 'Order {{order}} from {{store}}: {{total}}',
      totalLabel: '',
      ending: '',
      confirmButton: 'Confirm',
      cancelButton: 'Cancel',
    },
    isActive: false,
    isDefault: false,
    reviewStatus: 'pending',
    category: 'utility',
    lastSyncedAt: null,
    ...change,
  };
}
