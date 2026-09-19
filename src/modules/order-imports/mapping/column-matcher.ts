import {
  AMBIGUOUS_NAME_KEY,
  FIELD_ALIAS_KEYS,
  FIRST_NAME_KEYS,
  IMPORT_FIELDS,
  LAST_NAME_KEYS,
  REQUIRED_IMPORT_FIELDS,
  type ImportField,
} from './alias-dictionary';
import { headerKey } from './header-key';

export type MatchConfidence = 'exact' | 'partial' | 'none';
export type SuggestionSource = 'auto' | 'saved' | 'none';

export interface FieldSuggestion {
  field: ImportField;
  required: boolean;
  /** One column; two only for a first + last name pair. */
  columns: string[];
  confidence: MatchConfidence;
  source: SuggestionSource;
  /** Other columns that also look like this field, best first. */
  alternatives: string[];
}

export interface ColumnSuggestions {
  fields: FieldSuggestion[];
  /** Columns no field uses; they are not imported (AC4). */
  unmappedColumns: string[];
}

/** Partial matches need an alias of at least this many characters (AC1). */
const MIN_PARTIAL_ALIAS_LENGTH = 3;
const DUPLICATE_SUFFIX = /^(.*) \((\d+)\)$/;
const ALL_DIGITS = /^\d+$/;
/** `Name` ranks below every real reference alias when it is a reference. */
const AMBIGUOUS_NAME_REFERENCE_RANK = 9;

interface Column {
  header: string;
  index: number;
  key: string;
}

interface Candidate {
  column: Column;
  rank: number;
}

/**
 * `Phone (2)` is the header normalizer's name for a second `Phone` column; it
 * is matched as `Phone` so the first one wins and the second is an
 * alternative. A genuine header such as `Size (2)` keeps its own key.
 */
function toColumns(headers: readonly string[]): Column[] {
  const present = new Set(headers);
  return headers.map((header, index) => {
    const duplicate = DUPLICATE_SUFFIX.exec(header);
    const base = duplicate && present.has(duplicate[1]) ? duplicate[1] : header;
    return { header, index, key: headerKey(base) };
  });
}

function byRankThenPosition(a: Candidate, b: Candidate): number {
  return a.rank - b.rank || a.column.index - b.column.index;
}

function exactCandidates(field: ImportField, columns: Column[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const column of columns) {
    if (!column.key) continue;
    const alias = FIELD_ALIAS_KEYS[field].find(({ key }) => key === column.key);
    if (alias) candidates.push({ column, rank: alias.rank });
  }
  return candidates.sort(byRankThenPosition);
}

/** True when most non-empty samples look like `#1001` or `1001`. */
function looksLikeReferences(values: readonly string[]): boolean {
  const filled = values.map((value) => value.trim()).filter(Boolean);
  if (filled.length === 0) return false;
  const referenceLike = filled.filter(
    (value) => value.startsWith('#') || ALL_DIGITS.test(headerKey(value)),
  ).length;
  return referenceLike * 2 > filled.length;
}

function partialAliasKeys(field: ImportField): string[] {
  const keys = FIELD_ALIAS_KEYS[field].map(({ key }) => key);
  if (field === 'customerName') keys.push(AMBIGUOUS_NAME_KEY);
  return keys.filter((key) => key.length >= MIN_PARTIAL_ALIAS_LENGTH);
}

/**
 * Suggests a source column for every canonical field (US-04.6-03 AC1–AC3).
 * Pure: the same headers and samples always give the same suggestions.
 *
 * 1. Exact: the header key equals an alias. Several exact columns are settled
 *    by alias rank, then by column order; the rest are alternatives. Customer
 *    name may be a first + last name pair when no full-name column exists. A
 *    bare `Name` column is the customer name only when no other name column
 *    exists and its samples are not mostly `#1001`-style references;
 *    otherwise it is an order reference candidate.
 * 2. Partial, only for fields still empty and columns still unused: the key
 *    contains an alias of 3+ characters. One candidate is a partial match;
 *    several leave the field empty with the candidates as alternatives.
 *
 * A column is never suggested for two fields.
 */
export function matchColumns(
  headers: readonly string[],
  sampleRows: readonly (readonly string[])[],
): ColumnSuggestions {
  const columns = toColumns(headers);
  const used = new Set<number>();
  const result = new Map<ImportField, FieldSuggestion>(
    IMPORT_FIELDS.map((field) => [
      field,
      {
        field,
        required: REQUIRED_IMPORT_FIELDS.includes(field),
        columns: [],
        confidence: 'none',
        source: 'none',
        alternatives: [],
      },
    ]),
  );
  const assign = (
    field: ImportField,
    chosen: Column[],
    confidence: MatchConfidence,
    alternatives: Column[],
  ) => {
    const suggestion = result.get(field)!;
    suggestion.columns = chosen.map((column) => column.header);
    suggestion.confidence = confidence;
    suggestion.source = chosen.length > 0 ? 'auto' : 'none';
    suggestion.alternatives = alternatives.map((column) => column.header);
    chosen.forEach((column) => used.add(column.index));
  };

  const nameColumns = columns.filter(
    (column) => column.key === AMBIGUOUS_NAME_KEY,
  );
  const firstName = columns.find((column) =>
    FIRST_NAME_KEYS.includes(column.key),
  );
  const lastName = columns.find((column) =>
    LAST_NAME_KEYS.includes(column.key),
  );
  const fullNames = exactCandidates('customerName', columns);
  const otherNameCandidateExists =
    fullNames.length > 0 || firstName !== undefined;
  const nameIsCustomer =
    nameColumns.length > 0 &&
    !otherNameCandidateExists &&
    !looksLikeReferences(
      sampleRows.map((row) => row[nameColumns[0].index] ?? ''),
    );

  // Pass 1: exact.
  for (const field of IMPORT_FIELDS) {
    const candidates = exactCandidates(field, columns);
    if (field === 'customerName' && nameIsCustomer)
      candidates.push(...nameColumns.map((column) => ({ column, rank: 0 })));
    if (field === 'orderReference' && !nameIsCustomer)
      candidates.push(
        ...nameColumns.map((column) => ({
          column,
          rank: AMBIGUOUS_NAME_REFERENCE_RANK,
        })),
      );
    candidates.sort(byRankThenPosition);
    const free = candidates.filter(({ column }) => !used.has(column.index));
    if (free.length > 0) {
      assign(
        field,
        [free[0].column],
        'exact',
        free.slice(1).map(({ column }) => column),
      );
      continue;
    }
    if (
      field === 'customerName' &&
      firstName &&
      lastName &&
      !used.has(firstName.index) &&
      !used.has(lastName.index)
    )
      assign(field, [firstName, lastName], 'exact', []);
  }

  // Pass 2: partial, for what is still empty.
  for (const field of IMPORT_FIELDS) {
    const suggestion = result.get(field)!;
    if (suggestion.columns.length > 0) continue;
    const keys = partialAliasKeys(field);
    const candidates = columns.filter(
      (column) =>
        !used.has(column.index) &&
        column.key !== '' &&
        keys.some((key) => column.key.includes(key)),
    );
    if (candidates.length === 1) assign(field, candidates, 'partial', []);
    else if (candidates.length > 1) assign(field, [], 'none', candidates);
  }

  return {
    fields: IMPORT_FIELDS.map((field) => result.get(field)!),
    unmappedColumns: columns
      .filter((column) => !used.has(column.index))
      .map((column) => column.header),
  };
}
