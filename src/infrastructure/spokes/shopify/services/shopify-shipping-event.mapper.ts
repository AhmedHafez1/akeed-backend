import { findMatchingShippingTag } from '../../../../shared/shipping/shipping-tags';
import type { ShippingTracking } from '../../../../shared/shipping/shipping-notification.types';
import type {
  ShippingDetection,
  ShippingDetectionSettings,
  ShippingOrderRef,
} from '../../../../modules/shipping-notifications/shipping-event-source';

const SHIPPED_FULFILLMENT_STATUSES = new Set(['fulfilled', 'partial']);
/** A fulfillment in one of these states never left the warehouse. */
const VOID_FULFILLMENT_STATUSES = new Set(['cancelled', 'error', 'failure']);
const TRACKING_NUMBER_MAX_LENGTH = 255;
const TRACKING_URL_MAX_LENGTH = 2048;

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function isoTime(value: unknown): string | null {
  const raw = text(value);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
}

function firstText(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return null;
}

/** Keeps only an absolute `https:` link of a sane length. */
export function safeTrackingUrl(value: string | null): string | null {
  if (!value || value.length > TRACKING_URL_MAX_LENGTH) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function fulfillmentsOf(raw: Raw): Raw[] {
  return Array.isArray(raw.fulfillments)
    ? raw.fulfillments.filter(isRecord)
    : [];
}

function isLiveFulfillment(fulfillment: Raw): boolean {
  const status = text(fulfillment.status)?.toLowerCase();
  return !status || !VOID_FULFILLMENT_STATUSES.has(status);
}

/** Shopify's order tags: a comma-separated string, or a list. */
export function parseShopifyTags(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.filter((tag): tag is string => typeof tag === 'string')
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return parts.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}

/** Whether the order has shipped, in whole or in part. */
export function isShopifyOrderFulfilled(raw: Raw): boolean {
  const status = text(raw.fulfillment_status)?.toLowerCase();
  if (status && SHIPPED_FULFILLMENT_STATUSES.has(status)) return true;
  return fulfillmentsOf(raw).some(isLiveFulfillment);
}

/**
 * Tracking from the first live fulfillment that has a number or a link. Each
 * field reads both Shopify spellings: the single value and the list.
 */
export function readShopifyTracking(raw: Raw): ShippingTracking | undefined {
  for (const fulfillment of fulfillmentsOf(raw).filter(isLiveFulfillment)) {
    const number =
      text(fulfillment.tracking_number) ??
      firstText(fulfillment.tracking_numbers);
    const url = safeTrackingUrl(
      text(fulfillment.tracking_url) ?? firstText(fulfillment.tracking_urls),
    );
    const safeNumber =
      number && [...number].length <= TRACKING_NUMBER_MAX_LENGTH
        ? number
        : null;
    if (safeNumber || url) {
      return {
        ...(safeNumber ? { number: safeNumber } : {}),
        ...(url ? { url } : {}),
      };
    }
  }
  return undefined;
}

const STORED_FULFILLMENT_FIELDS = [
  'status',
  'tracking_number',
  'tracking_numbers',
  'tracking_url',
  'tracking_urls',
] as const;

/**
 * The part of an `orders/updated` payload that is stored: the order's id,
 * dates, test flag, tags and fulfillment tracking. Customer, address and line
 * item data are left out.
 */
export function projectShopifyOrderUpdate(raw: Raw): Raw {
  const fulfillments = fulfillmentsOf(raw).map((fulfillment) =>
    Object.fromEntries(
      STORED_FULFILLMENT_FIELDS.filter((key) => key in fulfillment).map(
        (key) => [key, fulfillment[key]],
      ),
    ),
  );
  return {
    id: raw.id,
    created_at: raw.created_at ?? null,
    updated_at: raw.updated_at ?? null,
    cancelled_at: raw.cancelled_at ?? null,
    test: raw.test === true,
    tags: raw.tags ?? null,
    fulfillment_status: raw.fulfillment_status ?? null,
    fulfillments,
  };
}

export function readShopifyOrderRef(raw: Raw): ShippingOrderRef | null {
  const id = raw.id;
  const externalOrderId =
    typeof id === 'number' && Number.isSafeInteger(id) && id > 0
      ? String(id)
      : typeof id === 'string' && /^\d{1,20}$/.test(id.trim())
        ? id.trim()
        : null;
  if (!externalOrderId) return null;
  return {
    externalOrderId,
    sourceCreatedAt: isoTime(raw.created_at),
    sourceCancelledAt: isoTime(raw.cancelled_at),
    isTest: raw.test === true,
  };
}

/**
 * The Shipped signal in an `orders/updated` payload. A fulfillment counts when
 * the merchant left the fulfillment trigger on; a saved tag counts whenever it
 * is on the order. Akeed's own tags never match.
 */
export function detectShopifyShipping(
  raw: Raw,
  settings: ShippingDetectionSettings,
): ShippingDetection | null {
  if (settings.fulfillmentTriggerEnabled && isShopifyOrderFulfilled(raw)) {
    const tracking = readShopifyTracking(raw);
    return {
      stage: 'shipped',
      trigger: 'fulfillment',
      ...(tracking ? { tracking } : {}),
    };
  }
  const matchedTag = findMatchingShippingTag(
    parseShopifyTags(raw.tags),
    settings.tags,
  );
  if (matchedTag) {
    const tracking = readShopifyTracking(raw);
    return {
      stage: 'shipped',
      trigger: 'tag',
      matchedTag,
      ...(tracking ? { tracking } : {}),
    };
  }
  return null;
}
