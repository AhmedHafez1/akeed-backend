import type { OnboardingShippingCurrency } from '../../onboarding/dto/onboarding.dto';
import {
  IMPORT_FIELDS,
  REQUIRED_IMPORT_FIELDS,
  type ImportField,
} from './alias-dictionary';
import type { FieldSuggestion } from './column-matcher';

type SingleColumnField = Exclude<ImportField, 'customerName'>;

/**
 * Which file column feeds each canonical field. Every field takes at most one
 * column; the customer name may take two (first and last, joined by a space).
 * `null` / `[]` means not imported.
 */
export type ImportColumnMapping = Record<SingleColumnField, string | null> & {
  customerName: string[];
};

export const IMPORT_DATE_FORMATS = ['auto', 'DMY', 'MDY', 'YMD'] as const;
export type ImportDateFormat = (typeof IMPORT_DATE_FORMATS)[number];

export type PaymentClassification = 'cod' | 'not_cod';

/** Import options stored on the batch and the saved profile (AC5). */
export interface ImportOptions {
  country: string;
  defaultCurrency: OnboardingShippingCurrency;
  dateFormat: ImportDateFormat;
  /** Keyed by `normalizePaymentValue`. */
  paymentValueMap: Record<string, PaymentClassification>;
}

/** How a field got its column: detected, a saved profile, or the merchant. */
export type MappingSource = 'auto' | 'saved' | 'merchant' | 'none';

/** `order_import_batches.mapping`. */
export interface StoredImportMapping {
  dictionaryVersion: number;
  /** False while it is only a suggestion; true once the merchant saved it. */
  confirmed: boolean;
  columns: ImportColumnMapping;
  sources: Record<ImportField, MappingSource>;
}

export const MAX_CUSTOMER_NAME_COLUMNS = 2;

export function columnsOf(
  mapping: ImportColumnMapping,
  field: ImportField,
): string[] {
  if (field === 'customerName') return mapping.customerName;
  const column = mapping[field];
  return column ? [column] : [];
}

export function mappingFromSuggestions(
  fields: readonly FieldSuggestion[],
): ImportColumnMapping {
  const mapping = Object.fromEntries(
    IMPORT_FIELDS.map((field) => [field, null]),
  ) as Record<SingleColumnField, string | null>;
  let customerName: string[] = [];
  for (const suggestion of fields) {
    if (suggestion.field === 'customerName')
      customerName = [...suggestion.columns];
    else mapping[suggestion.field] = suggestion.columns[0] ?? null;
  }
  return { ...mapping, customerName };
}

/** Columns the mapping does not use, in file order (not imported). */
export function unmappedColumns(
  headers: readonly string[],
  mapping: ImportColumnMapping,
): string[] {
  const used = new Set(
    IMPORT_FIELDS.flatMap((field) => columnsOf(mapping, field)),
  );
  return headers.filter((header) => !used.has(header));
}

/**
 * The structural mapping rules (AC4): the required fields are mapped, every
 * column exists in the file, a column feeds one field only, and the customer
 * name takes one or two different columns. Returns field errors keyed by
 * field; empty means valid.
 */
export function validateMappingStructure(
  headers: readonly string[],
  mapping: ImportColumnMapping,
): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  const present = new Set(headers);
  const owner = new Map<string, ImportField>();

  for (const field of IMPORT_FIELDS) {
    const columns = columnsOf(mapping, field);
    if (columns.length === 0) {
      if (REQUIRED_IMPORT_FIELDS.includes(field))
        fieldErrors[field] = `${field} must be mapped to a column.`;
      continue;
    }
    if (columns.length > MAX_CUSTOMER_NAME_COLUMNS) {
      fieldErrors[field] = `${field} takes at most two columns.`;
      continue;
    }
    if (new Set(columns).size !== columns.length) {
      fieldErrors[field] = `${field} uses the same column twice.`;
      continue;
    }
    for (const column of columns) {
      if (!present.has(column)) {
        fieldErrors[field] =
          `${field} refers to a column that is not in the file.`;
        break;
      }
      const other = owner.get(column);
      if (other) {
        fieldErrors[field] =
          `${field} uses a column already mapped to ${other}.`;
        break;
      }
      owner.set(column, field);
    }
  }
  return fieldErrors;
}
