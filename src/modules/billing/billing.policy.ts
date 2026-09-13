import { createHash, randomBytes } from 'node:crypto';
import type { CreditSummary } from '../../shared/ports/credit-accounting.port';
import type { OrganizationRole } from '../auth/organization-role';
import { canWriteOrganization } from '../auth/organization-role';
import {
  BILLING_ERROR_CODES,
  PURCHASE_CURRENCY,
  type PurchasePricing,
} from './billing.types';

/**
 * Pure decisions for the merchant billing API: what a purchase costs, who may
 * start one, and how a page of history is addressed.
 *
 * Nothing here reads a request body for money. Quantity is the only merchant
 * input, and it is checked against server-owned bounds before it is multiplied.
 */

/** Postgres `integer`, the width of every money and credit column. */
const MAX_DATABASE_INTEGER = 2147483647;

export class PurchaseQuantityError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

export interface PricedPurchase {
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  currency: string;
}

/**
 * Prices a requested quantity from configuration alone.
 *
 * The bounds are re-checked here even though the DTO validates them: the DTO
 * describes the request, this describes what Akeed is willing to charge, and
 * only one of those two may be authority for money.
 */
export function priceQuantity(
  quantity: number,
  pricing: PurchasePricing,
): PricedPurchase {
  if (!Number.isSafeInteger(quantity))
    throw new PurchaseQuantityError('quantity must be a whole number.');
  if (quantity < pricing.purchaseMin || quantity > pricing.purchaseMax)
    throw new PurchaseQuantityError(
      `quantity must be between ${pricing.purchaseMin} and ${pricing.purchaseMax}.`,
    );
  if (quantity % pricing.purchaseStep !== 0)
    throw new PurchaseQuantityError(
      `quantity must be a multiple of ${pricing.purchaseStep}.`,
    );
  const totalMinor = quantity * pricing.priceMinor;
  // The configuration parser already proves max * price fits, but the product
  // is what actually reaches an integer column, so it is checked where it is
  // computed rather than trusted from two files away.
  if (!Number.isSafeInteger(totalMinor) || totalMinor > MAX_DATABASE_INTEGER)
    throw new PurchaseQuantityError('quantity exceeds the payable amount.');
  return {
    quantity,
    unitPriceMinor: pricing.priceMinor,
    totalMinor,
    currency: PURCHASE_CURRENCY,
  };
}

export type PurchaseDenialCode =
  | typeof BILLING_ERROR_CODES.disabled
  | typeof BILLING_ERROR_CODES.sourceUnsupported
  | typeof BILLING_ERROR_CODES.roleRequired
  | typeof BILLING_ERROR_CODES.accountNotProvisioned
  | typeof BILLING_ERROR_CODES.accountSuspended;

/**
 * Why this member cannot start a checkout right now.
 *
 * Deliberately not `creditDenial`: that answers whether a *send* may be billed,
 * and refuses on zero balance and debt. Those are the exact states a merchant
 * buys credits to leave, so they must never close the till.
 */
export function purchaseDenial(input: {
  enabled: boolean;
  platformType: string | null;
  role: OrganizationRole | null;
  summary: Pick<CreditSummary, 'status'> | undefined;
}): PurchaseDenialCode | null {
  if (!input.enabled) return BILLING_ERROR_CODES.disabled;
  if (input.platformType !== 'standalone')
    return BILLING_ERROR_CODES.sourceUnsupported;
  if (!input.role || !canWriteOrganization(input.role))
    return BILLING_ERROR_CODES.roleRequired;
  if (!input.summary) return BILLING_ERROR_CODES.accountNotProvisioned;
  if (input.summary.status === 'suspended')
    return BILLING_ERROR_CODES.accountSuspended;
  return null;
}

/**
 * An opaque merchant-facing purchase identifier.
 *
 * Random rather than sequential: it is the `special_reference` Paymob echoes
 * back and the value a merchant may paste into a support ticket, so it must
 * leak neither volume nor tenant.
 */
export function buildPurchaseReference(): string {
  return `akd_${randomBytes(16).toString('hex')}`;
}

export const PURCHASE_REFERENCE_PATTERN = /^akd_[a-f0-9]{32}$/;

/**
 * Binds an idempotency key to the terms it was first used with, so replaying
 * the key with a different quantity is a conflict rather than a second charge.
 */
export function buildRequestHash(input: {
  orgId: string;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  currency: string;
}): string {
  return createHash('sha256')
    .update(
      [
        'v1',
        input.orgId,
        input.quantity,
        input.unitPriceMinor,
        input.totalMinor,
        input.currency,
      ].join('|'),
    )
    .digest('hex');
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Mirrors the manual-order rule so merchants meet one format, not two. */
export function normalizeIdempotencyKey(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized)
    throw new PurchaseQuantityError('Idempotency-Key is required.');
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized))
    throw new PurchaseQuantityError(
      'Idempotency-Key must be 8-128 characters of letters, digits, dot, underscore, colon or hyphen.',
    );
  return normalized;
}

export interface HistoryCursor {
  createdAt: string;
  id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keyset cursor over `(created_at, id)`.
 *
 * It carries no authority -- the organization always comes from the token -- so
 * it needs no signature, only strict decoding so a malformed value is a 400
 * rather than a silently different page.
 */
export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(value: string | undefined): HistoryCursor | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { v, createdAt, id } = parsed as Record<string, unknown>;
  if (v !== 1 || typeof createdAt !== 'string' || typeof id !== 'string')
    return null;
  if (!UUID_PATTERN.test(id) || Number.isNaN(Date.parse(createdAt)))
    return null;
  return { createdAt, id };
}

/** Splits an over-fetched page into its items and the cursor after them. */
export function paginate<T extends HistoryCursor>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}
