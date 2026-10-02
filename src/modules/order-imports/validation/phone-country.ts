import type { StandardizeMobile } from './phone';
import { cleanCell } from './text';

/** Enough phones to tell a country by; a longer file adds nothing. */
const SAMPLE_SIZE = 200;

export interface PhoneCountryDeps {
  standardizeMobile: StandardizeMobile;
  /** The calling code of a country (`966` for `SA`), or null when unknown. */
  callingCodeOf: (country: string) => number | null;
}

/**
 * The country most of a file's phones belong to, or null when none of them
 * reads as a mobile in any candidate.
 *
 * A phone votes for a country when it is a valid mobile there and the result
 * carries that country's calling code: `+966...` is valid whatever the import
 * country, so without the second check it would vote for every candidate. A
 * tie goes to the earlier candidate, so callers put their fallback first.
 */
export function detectPhoneCountry(
  phones: readonly string[],
  candidates: readonly string[],
  deps: PhoneCountryDeps,
): string | null {
  const sample: string[] = [];
  for (const phone of phones) {
    const cell = cleanCell(phone);
    if (cell) sample.push(cell);
    if (sample.length === SAMPLE_SIZE) break;
  }

  let detected: string | null = null;
  let mostVotes = 0;
  for (const country of candidates) {
    const callingCode = deps.callingCodeOf(country);
    if (callingCode === null) continue;
    const prefix = `+${callingCode}`;
    const votes = sample.filter((cell) => {
      const result = deps.standardizeMobile(cell, country);
      return result.ok && result.e164.startsWith(prefix);
    }).length;
    if (votes > mostVotes) {
      detected = country;
      mostVotes = votes;
    }
  }
  return detected;
}
