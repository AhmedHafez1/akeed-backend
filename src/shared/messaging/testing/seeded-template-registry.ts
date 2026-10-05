import type { TemplateRegistryPort } from '../../ports/template-registry.port';
import {
  COD_TEMPLATE_DEFAULTS,
  getAvailableCodTemplateDefinitions,
} from '../cod-template-catalog';
import {
  COD_CONFIRMATION_PURPOSE,
  TEMPLATE_LANGUAGES,
  buildCodConfirmationKey,
  type RegistryTemplate,
} from '../template-registry.types';

/**
 * The registry as migration 0054 seeds it, built from the code catalog. For
 * specs only: the catalog file is the seed source and the characterization
 * baseline until the US-08-08 gate, and nothing at runtime reads it.
 */
export function seededRegistryTemplates(): RegistryTemplate[] {
  const definitions = getAvailableCodTemplateDefinitions();
  return TEMPLATE_LANGUAGES.flatMap((language) =>
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
      }),
    ),
  );
}

/** An in-memory registry port over the given rows (the seed by default). */
export function seededTemplateRegistry(
  templates: readonly RegistryTemplate[] = seededRegistryTemplates(),
): TemplateRegistryPort {
  return {
    listTemplates: () => Promise.resolve(templates),
    invalidate: () => undefined,
  };
}
