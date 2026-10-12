import type { VerificationExportRow } from '../../infrastructure/database/repositories/verifications.repository';

/** Most rows one export holds; a larger set is narrowed by tab or period. */
export const VERIFICATION_EXPORT_ROW_LIMIT = 5000;

const HEADERS = [
  'Order',
  'Customer',
  'Phone',
  'Total',
  'Currency',
  'Status',
  'Order time',
  'Confirmed at',
  'Canceled at',
  'City / region',
  'Address',
  'Items',
];

// Spreadsheet apps decode a CSV as UTF-8 only when it starts with this mark;
// without it Arabic names open as mojibake in Excel.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];
const PLAIN_NUMBER = /^[+-]?[\d\s().-]+$/;

/**
 * One CSV cell.
 *
 * A value a spreadsheet would run as a formula is prefixed with an apostrophe
 * so it stays text; phone numbers and amounts start with the same characters
 * and are left alone, since digits alone cannot form a formula.
 */
function toCell(value: string | null | undefined): string {
  let text = value ?? '';
  if (
    text.length > 0 &&
    FORMULA_TRIGGERS.includes(text[0]) &&
    !PLAIN_NUMBER.test(text)
  ) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatLocalTime(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  // The Swedish locale formats as `YYYY-MM-DD HH:mm`, which sorts and parses
  // the same in every spreadsheet locale.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function formatItems(row: VerificationExportRow): string {
  return (row.lineItems ?? [])
    .map((item) => {
      const options = (item.options ?? [])
        .map((option) => option.value)
        .filter(Boolean)
        .join(', ');
      return `${item.quantity} x ${item.name}${options ? ` (${options})` : ''}`;
    })
    .join('; ');
}

/** The confirmations export file, times in the merchant's reporting zone. */
export function buildVerificationsCsv(
  rows: VerificationExportRow[],
  timeZone: string,
): string {
  const lines = rows.map((row) =>
    [
      row.orderNumber,
      row.customerName,
      row.customerPhone,
      row.totalPrice,
      row.currency,
      row.status,
      formatLocalTime(row.createdAt, timeZone),
      formatLocalTime(row.confirmedAt, timeZone),
      formatLocalTime(row.canceledAt, timeZone),
      row.shippingRegion,
      row.shippingAddress,
      formatItems(row),
    ]
      .map(toCell)
      .join(','),
  );
  return `${BYTE_ORDER_MARK}${[HEADERS.join(','), ...lines].join('\r\n')}\r\n`;
}
