import { Transform } from 'class-transformer';

function trim(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** Trims string values before validation; leaves non-strings untouched. */
export function TrimString(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) => trim(value));
}

/**
 * Trims string values and converts an empty result to `undefined`, so an
 * optional field submitted as whitespace is treated as not provided.
 */
export function TrimOptionalString(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) => {
    const normalized = trim(value);
    return normalized === '' ? undefined : normalized;
  });
}
