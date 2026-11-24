/** Limits on the merchant's shipping tag list. */
export const SHIPPING_TAGS_MAX = 10;
export const SHIPPING_TAG_MAX_LENGTH = 40;

/**
 * Akeed writes its own order tags (`Akeed: Verified` and others). They must
 * never count as a shipping signal, so they can't be saved or matched.
 */
const AKEED_TAG_PREFIX = 'akeed:';

/**
 * The comparison form of a tag: trimmed, compatibility-normalised and
 * lower-cased. `toLowerCase` is Unicode-aware, and scripts without case, such
 * as Arabic, compare as written.
 */
export function shippingTagKey(tag: string): string {
  return tag.trim().normalize('NFKC').toLowerCase();
}

export function isAkeedTag(tag: string): boolean {
  return shippingTagKey(tag).startsWith(AKEED_TAG_PREFIX);
}

export type ShippingTagsError = 'too_many' | 'length' | 'akeed_prefix';

export type ShippingTagsResult =
  | { ok: true; tags: string[] }
  | { ok: false; reason: ShippingTagsError };

/**
 * Checks and tidies the merchant's tag list: each tag is trimmed, must be
 * 1-40 characters and must not be an Akeed tag. Tags that compare equal are
 * kept once, in their first spelling, before the count limit applies.
 */
export function normalizeShippingTagSettings(
  raw: readonly string[],
): ShippingTagsResult {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const tag = value.trim();
    if (tag.length < 1 || [...tag].length > SHIPPING_TAG_MAX_LENGTH) {
      return { ok: false, reason: 'length' };
    }
    if (isAkeedTag(tag)) return { ok: false, reason: 'akeed_prefix' };
    const key = shippingTagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > SHIPPING_TAGS_MAX) return { ok: false, reason: 'too_many' };
  return { ok: true, tags };
}

/**
 * The first saved tag present on the order, in its saved spelling. Akeed tags
 * on the order are ignored.
 */
export function findMatchingShippingTag(
  orderTags: readonly string[],
  savedTags: readonly string[],
): string | null {
  const present = new Set(
    orderTags.filter((tag) => !isAkeedTag(tag)).map(shippingTagKey),
  );
  for (const saved of savedTags) {
    if (isAkeedTag(saved)) continue;
    const key = shippingTagKey(saved);
    if (key && present.has(key)) return saved;
  }
  return null;
}
