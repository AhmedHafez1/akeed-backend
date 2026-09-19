import { outcomeOf, type RowIssue, type RowIssueCode } from './issue-codes';
import type { NormalizedImportOrder } from './row-validator';

export interface BatchRow {
  rowNumber: number;
  normalized: NormalizedImportOrder;
  issues: RowIssue[];
  dedupeKey: string | null;
  collapsedInto: number | null;
}

/** Blank cells on a line-item row: the first row of its order carries them. */
const LINE_ITEM_BLANKS: readonly RowIssueCode[] = [
  'PHONE_MISSING',
  'NAME_MISSING',
  'AMOUNT_MISSING',
];

function hasIssue(row: BatchRow, code: RowIssueCode): boolean {
  return row.issues.some((issue) => issue.code === code);
}

/** Every value present in the group is the same one; blanks agree with any. */
function agrees(
  rows: readonly BatchRow[],
  value: (row: BatchRow) => string | undefined,
): boolean {
  return new Set(rows.map(value).filter(Boolean)).size <= 1;
}

function collapse(head: BatchRow, follower: BatchRow): void {
  follower.collapsedInto = head.rowNumber;
  follower.issues = [
    ...follower.issues.filter(
      (issue) => !LINE_ITEM_BLANKS.includes(issue.code),
    ),
    {
      code: 'DUPLICATE_IN_FILE',
      params: { rowNumber: head.rowNumber },
    },
  ];
}

function groupBy(
  rows: readonly BatchRow[],
  key: (row: BatchRow) => string | null,
): BatchRow[][] {
  const groups = new Map<string, BatchRow[]>();
  for (const row of rows) {
    const value = key(row);
    if (value === null) continue;
    const group = groups.get(value);
    if (group) group.push(row);
    else groups.set(value, [row]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * In-file duplicates, L2 (AC9). Rows must be in row-number order; they are
 * updated in place.
 *
 * - Rows sharing a reference key whose phone and amount agree are one order
 *   exported as line items: the lowest row keeps it and the others collapse
 *   into it. A line-item row may leave phone, name and amount blank.
 * - Rows sharing a key but disagreeing on phone or amount are all invalid:
 *   Akeed cannot tell which one is the order.
 * - Reference-less rows identical in phone, name, amount and date collapse.
 */
export function applyInFileDedupe(rows: readonly BatchRow[]): void {
  for (const group of groupBy(rows, (row) => row.dedupeKey)) {
    const consistent =
      agrees(group, (row) => row.normalized.customerPhone) &&
      agrees(group, (row) => row.normalized.totalPrice) &&
      !group.some(
        (row) =>
          hasIssue(row, 'PHONE_INVALID') || hasIssue(row, 'AMOUNT_INVALID'),
      );
    if (!consistent) {
      for (const row of group)
        row.issues.push({
          code: 'ORDER_REF_CONFLICT_IN_FILE',
          field: 'orderReference',
        });
      continue;
    }
    const [head, ...followers] = group;
    for (const follower of followers) collapse(head, follower);
  }

  const identity = (row: BatchRow): string | null => {
    const { customerPhone, customerName, totalPrice, orderDate } =
      row.normalized;
    if (row.dedupeKey || !customerPhone || !customerName || !totalPrice)
      return null;
    return JSON.stringify([customerPhone, customerName, totalPrice, orderDate]);
  };
  for (const [head, ...followers] of groupBy(rows, identity))
    for (const follower of followers) collapse(head, follower);
}

/** An order of the same source found by the L1 or L3 lookups. */
export interface ExistingOrderMatch {
  id: string;
  externalOrderId: string;
  orderNumber: string | null;
  customerPhone: string;
  totalPrice: string | null;
  /** `YYYY-MM-DD` in the store timezone. */
  createdDate: string;
  createdAt: string;
}

export interface ExistingOrders {
  byExternalId: readonly ExistingOrderMatch[];
  recentByPhone: readonly ExistingOrderMatch[];
  recentByOrderNumber: readonly ExistingOrderMatch[];
}

function sameAmount(order: ExistingOrderMatch, totalPrice: string): boolean {
  return (
    order.totalPrice !== null &&
    Number(order.totalPrice).toFixed(2) === totalPrice
  );
}

/** Newest first, then by id, so the reported match never depends on query order. */
function newest(
  matches: readonly ExistingOrderMatch[],
): ExistingOrderMatch | undefined {
  return [...matches].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  )[0];
}

/**
 * Database duplicates for rows that are still ready (AC10, AC11). L1 makes a
 * row whose reference already exists for the source a duplicate; L3 holds back
 * a row that looks like a recent order (same phone and amount, or the same
 * order number) until the merchant includes it.
 */
export function applyExistingOrderMatches(
  rows: readonly BatchRow[],
  existing: ExistingOrders,
): void {
  const byExternalId = new Map(
    existing.byExternalId.map((order) => [order.externalOrderId, order]),
  );
  for (const row of rows) {
    if (outcomeOf(row.issues) !== 'ready') continue;
    const imported = row.dedupeKey
      ? byExternalId.get(row.dedupeKey)
      : undefined;
    if (imported) {
      row.issues.push({
        code: 'ALREADY_IMPORTED',
        field: 'orderReference',
        params: { orderId: imported.id },
      });
      continue;
    }

    const { customerPhone, totalPrice, orderNumber } = row.normalized;
    const byPhone = newest(
      existing.recentByPhone.filter(
        (order) =>
          order.customerPhone === customerPhone &&
          totalPrice !== undefined &&
          sameAmount(order, totalPrice),
      ),
    );
    const byNumber = orderNumber
      ? newest(
          existing.recentByOrderNumber.filter(
            (order) =>
              order.orderNumber?.toLowerCase() === orderNumber.toLowerCase(),
          ),
        )
      : undefined;
    const matches = [byPhone, byNumber].filter(
      (match, index, all): match is ExistingOrderMatch =>
        match !== undefined &&
        all.findIndex((other) => other?.id === match.id) === index,
    );
    for (const match of matches)
      row.issues.push({
        code: 'POSSIBLE_DUPLICATE',
        params: {
          orderNumber: match.orderNumber ?? '',
          date: match.createdDate,
          match: match === byPhone ? 'phone_amount' : 'order_number',
        },
      });
  }
}
