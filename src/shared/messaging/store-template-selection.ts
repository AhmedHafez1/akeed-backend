import { storedTemplateKey } from './template-selector';
import {
  TEMPLATE_LANGUAGES,
  type TemplateLanguage,
} from './template-registry.types';

/**
 * The store fields that hold a store's template choice per language: the
 * first message, the reminder and, for the two languages that had them, the
 * old variant. Everything that reads or writes a store's choice goes through
 * this map, so a language is added here once.
 */
export const STORE_TEMPLATE_FIELDS = {
  ar: {
    key: 'codTemplateArKey',
    reminderKey: 'codReminderArKey',
    legacyVariant: 'codTemplateArVariant',
  },
  en: {
    key: 'codTemplateEnKey',
    reminderKey: 'codReminderEnKey',
    legacyVariant: 'codTemplateEnVariant',
  },
  ur: { key: 'codTemplateUrKey', reminderKey: 'codReminderUrKey' },
  es: { key: 'codTemplateEsKey', reminderKey: 'codReminderEsKey' },
  fr: { key: 'codTemplateFrKey', reminderKey: 'codReminderFrKey' },
} as const satisfies Record<
  TemplateLanguage,
  { key: string; reminderKey: string; legacyVariant?: string }
>;

type ValuesOf<T> = T extends unknown ? T[keyof T] : never;
export type StoreTemplateField = ValuesOf<
  (typeof STORE_TEMPLATE_FIELDS)[TemplateLanguage]
>;

/** The part of a store row a template choice is read from. */
export type StoreTemplateSource = Partial<
  Record<StoreTemplateField, string | null>
>;

export type TemplateKeysByLanguage = Partial<
  Record<TemplateLanguage, string | null>
>;

export function storeLegacyVariant(
  store: StoreTemplateSource,
  language: TemplateLanguage,
): string | null {
  const fields = STORE_TEMPLATE_FIELDS[language];
  return 'legacyVariant' in fields
    ? (store[fields.legacyVariant] ?? null)
    : null;
}

/** The first-message key a store sends in one language, as a send reads it. */
export function storeFirstSendKey(
  store: StoreTemplateSource,
  language: TemplateLanguage,
): string | null {
  return storedTemplateKey({
    language,
    key: store[STORE_TEMPLATE_FIELDS[language].key],
    legacyVariant: storeLegacyVariant(store, language),
  });
}

export function storeReminderKey(
  store: StoreTemplateSource,
  language: TemplateLanguage,
): string | null {
  return store[STORE_TEMPLATE_FIELDS[language].reminderKey] ?? null;
}

/** A store's choices in every language, in the shape the selector takes. */
export function storeTemplateKeys(store: StoreTemplateSource): {
  keys: TemplateKeysByLanguage;
  reminderKeys: TemplateKeysByLanguage;
} {
  const keys: TemplateKeysByLanguage = {};
  const reminderKeys: TemplateKeysByLanguage = {};
  for (const language of TEMPLATE_LANGUAGES) {
    keys[language] = storeFirstSendKey(store, language);
    reminderKeys[language] = storeReminderKey(store, language);
  }
  return { keys, reminderKeys };
}
