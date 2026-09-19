import { detectDateAmbiguity } from './date-ambiguity';

describe('detectDateAmbiguity (US-04.6-03 AC5)', () => {
  it.each([
    [
      'every date like 05/06/2026',
      ['05/06/2026', '01/02/2026', '12/12/2026'],
      true,
      null,
    ],
    ['short years and dashes', ['5-6-26', '7-8-26'], true, null],
    ['dates with a time', ['05.06.2026 14:30', '03.04.2026'], true, null],
    ['Arabic-Indic digits', ['٠٥/٠٦/٢٠٢٦'], true, null],
    ['one day over 12 proves DMY', ['05/06/2026', '13/06/2026'], false, 'DMY'],
    [
      'one month-second value over 12 proves MDY',
      ['05/06/2026', '06/18/2026'],
      false,
      'MDY',
    ],
    ['values proving both orders', ['13/06/2026', '06/18/2026'], false, null],
    ['only ISO dates', ['2026-06-05', '2026-06-06T10:00:00Z'], false, null],
    [
      'ISO dates next to ambiguous ones',
      ['2026-06-05', '05/06/2026'],
      true,
      null,
    ],
    ['text and blanks only', ['yesterday', ''], false, null],
    ['no values', [], false, null],
    [
      'a value valid in neither order',
      ['13/13/2026', '05/06/2026'],
      true,
      null,
    ],
  ])('%s', (_label, values, ambiguous, detectedFormat) => {
    expect(detectDateAmbiguity(values)).toEqual({ ambiguous, detectedFormat });
  });
});
