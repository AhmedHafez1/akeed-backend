import { DAY_MONTH_YEAR } from '../mapping/date-ambiguity';
import type { ImportDateFormat } from '../mapping/mapping-rules';
import type { RowIssue } from './issue-codes';

const DAY_MS = 86_400_000;
/** Excel's last serial (9999-12-31). */
const MAX_EXCEL_SERIAL = 2_958_465;
/** Excel's fictitious 1900-02-29; serials above it are one day late. */
const EXCEL_LEAP_BUG_SERIAL = 60;

const ISO_DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const YEAR_FIRST = /^(\d{2}|\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:[ T].*)?$/;
const EXCEL_SERIAL = /^\d{1,7}(?:\.\d+)?$/;

type YearMonthDay = readonly [year: number, month: number, day: number];

export interface OrderDateContext {
  /** The merchant's format, `auto` resolved by the column where it could be. */
  dateFormat: ImportDateFormat;
  /** What the whole column proves when the format is `auto`. */
  detectedFormat: 'DMY' | 'MDY' | null;
  timezone: string;
  now: Date;
  maxOrderAgeDays: number;
}

export interface OrderDateResult {
  /** `YYYY-MM-DD` in the store timezone; absent when blank or unreadable. */
  value?: string;
  issue?: RowIssue;
}

function fullYear(year: string): number {
  return year.length === 2 ? 2000 + Number(year) : Number(year);
}

function isoOf([year, month, day]: YearMonthDay): string | null {
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.toISOString().slice(0, 10);
}

/** Building a formatter is slow; one per timezone is reused across rows. */
const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = DATE_FORMATTERS.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      // An unknown zone name reads as UTC rather than failing the batch.
      formatter = dateFormatter('UTC');
    }
    DATE_FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

/** The calendar date of an instant in the store timezone. */
export function dateInTimezone(instant: Date, timezone: string): string {
  return dateFormatter(timezone).format(instant);
}

function excelSerialDate(serial: number): string | null {
  const whole = Math.floor(serial);
  if (whole < 1 || whole > MAX_EXCEL_SERIAL || whole === EXCEL_LEAP_BUG_SERIAL)
    return null;
  const offset = whole > EXCEL_LEAP_BUG_SERIAL ? whole - 1 : whole;
  return new Date(Date.UTC(1899, 11, 31) + offset * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function dayMonthOrder(
  first: number,
  second: number,
  context: OrderDateContext,
): 'DMY' | 'MDY' {
  if (context.dateFormat === 'DMY' || context.dateFormat === 'MDY')
    return context.dateFormat;
  if (first > 12) return 'DMY';
  if (second > 12) return 'MDY';
  // Undecidable here and in the column; day first is the region's norm.
  return context.detectedFormat ?? 'DMY';
}

/** Reads one date cell (AC7), or returns null when it is not a date. */
export function parseOrderDate(
  cell: string,
  context: OrderDateContext,
): string | null {
  const timestamp = ISO_TIMESTAMP.exec(cell);
  if (timestamp) {
    if (!timestamp[4])
      return isoOf([+timestamp[1], +timestamp[2], +timestamp[3]]);
    const instant = Date.parse(cell.replace(' ', 'T').replace(/\s+/g, ''));
    return Number.isNaN(instant)
      ? null
      : dateInTimezone(new Date(instant), context.timezone);
  }
  const iso = ISO_DATE.exec(cell);
  if (iso) return isoOf([+iso[1], +iso[2], +iso[3]]);
  if (EXCEL_SERIAL.test(cell)) return excelSerialDate(Number(cell));

  if (context.dateFormat === 'YMD') {
    const ymd = YEAR_FIRST.exec(cell);
    return ymd ? isoOf([fullYear(ymd[1]), +ymd[2], +ymd[3]]) : null;
  }
  const dmy = DAY_MONTH_YEAR.exec(cell);
  if (!dmy) return null;
  const first = Number(dmy[1]);
  const second = Number(dmy[2]);
  const year = fullYear(dmy[3]);
  return dayMonthOrder(first, second, context) === 'DMY'
    ? isoOf([year, second, first])
    : isoOf([year, first, second]);
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / DAY_MS;
}

/**
 * The order date (AC7). More than one day after today in the store is a data
 * error; older than the age window is a real order Akeed should not confirm
 * this late, so it is excluded rather than invalid.
 */
export function validateOrderDate(
  cell: string,
  context: OrderDateContext,
): OrderDateResult {
  if (!cell) return {};
  const value = parseOrderDate(cell, context);
  if (!value)
    return { issue: { code: 'ORDER_DATE_INVALID', field: 'orderDate' } };
  const today = dateInTimezone(context.now, context.timezone);
  const age = daysBetween(value, today);
  if (age < -1)
    return { value, issue: { code: 'ORDER_DATE_FUTURE', field: 'orderDate' } };
  if (age > context.maxOrderAgeDays)
    return {
      value,
      issue: {
        code: 'ORDER_TOO_OLD',
        field: 'orderDate',
        params: { maxAgeDays: context.maxOrderAgeDays },
      },
    };
  return { value };
}
