import { IMPORT_FIELDS, type ImportField } from './alias-dictionary';
import type { ColumnSuggestions, FieldSuggestion } from './column-matcher';
import { headerKey } from './header-key';

/**
 * A saved profile's column choice per field, as read back from the database.
 * Read defensively: a profile written by an older dictionary may lack fields.
 */
export type SavedColumns = Partial<Record<ImportField, unknown>>;

function savedColumnsFor(saved: SavedColumns, field: ImportField) {
  if (!(field in saved)) return undefined;
  const value = saved[field];
  if (value === null) return [];
  if (typeof value === 'string') return [value];
  if (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === 'string')
  )
    return value;
  return undefined;
}

/**
 * Finds the file column a saved header refers to: the same header, or else
 * the one header with the same key (`PHONE` for a saved `Phone`).
 */
function resolveColumn(
  saved: string,
  headers: readonly string[],
): string | null {
  if (headers.includes(saved)) return saved;
  const key = headerKey(saved);
  const sameKey = headers.filter((header) => headerKey(header) === key);
  return key !== '' && sameKey.length === 1 ? sameKey[0] : null;
}

/**
 * Lays a saved profile over the detected suggestions (US-04.6-03 AC8).
 *
 * A field whose saved columns are all still in the file takes them with
 * source `saved`, including a saved "not imported". A field whose saved
 * column is gone keeps its detected suggestion: the fallback is per field. A
 * detected suggestion that uses a column a saved field now claims is cleared,
 * so no column feeds two fields.
 */
export function applySavedProfile(
  detected: ColumnSuggestions,
  headers: readonly string[],
  saved: SavedColumns,
): ColumnSuggestions {
  const fromProfile = new Map<ImportField, string[]>();
  const claimed = new Set<string>();
  for (const field of IMPORT_FIELDS) {
    const columns = savedColumnsFor(saved, field);
    if (!columns) continue;
    const resolved = columns.map((column) => resolveColumn(column, headers));
    if (
      resolved.some((column) => column === null || claimed.has(column)) ||
      new Set(resolved).size !== resolved.length
    )
      continue;
    const chosen = resolved as string[];
    fromProfile.set(field, chosen);
    chosen.forEach((column) => claimed.add(column));
  }

  const fields = detected.fields.map((suggestion): FieldSuggestion => {
    const chosen = fromProfile.get(suggestion.field);
    const detectedColumns = [...suggestion.columns, ...suggestion.alternatives];
    if (chosen)
      return {
        ...suggestion,
        columns: chosen,
        confidence: chosen.length > 0 ? 'exact' : 'none',
        source: 'saved',
        alternatives: detectedColumns.filter((column) => !claimed.has(column)),
      };
    if (suggestion.columns.some((column) => claimed.has(column)))
      return {
        ...suggestion,
        columns: [],
        confidence: 'none',
        source: 'none',
        alternatives: detectedColumns.filter((column) => !claimed.has(column)),
      };
    return {
      ...suggestion,
      alternatives: suggestion.alternatives.filter(
        (column) => !claimed.has(column),
      ),
    };
  });

  const used = new Set(fields.flatMap((field) => field.columns));
  return {
    fields,
    unmappedColumns: headers.filter((header) => !used.has(header)),
  };
}
