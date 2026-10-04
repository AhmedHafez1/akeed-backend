import { isIP } from 'net';

/**
 * The canonical store URL (US-07-01 contract record, section 2).
 *
 * The address is merchant-supplied and treated as hostile. It is accepted
 * only in one shape and stored in one form, `https://<host>` or
 * `https://<host>/<path>`, and every later request to the store is built from
 * that stored form. The same rules canonicalize what the store reports about
 * itself, so the two can be compared for equality.
 */
export const WOOCOMMERCE_STORE_URL_MAX_LENGTH = 255;

export type WooCommerceStoreUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'invalid' | 'https_required' };

const INVALID: WooCommerceStoreUrlResult = { ok: false, reason: 'invalid' };

/** Longest input worth parsing at all. */
const INPUT_MAX_LENGTH = 2048;
const HOST_MAX_LENGTH = 253;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SCHEME_AND_REST = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;
/** A query, a fragment, an escape or a backslash anywhere in the address. */
const FORBIDDEN_CHARACTERS = /[?#%\\]/;
/** Akeed appends these itself; a store URL never contains them. */
const RESERVED_PATH_PARTS = ['wp-json', 'wc-auth'];

function hasSpaceOrControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function canonicalizeWooCommerceStoreUrl(
  input: unknown,
): WooCommerceStoreUrlResult {
  if (typeof input !== 'string') return INVALID;
  const raw = input.trim();
  if (!raw || raw.length > INPUT_MAX_LENGTH || hasSpaceOrControl(raw))
    return INVALID;

  const parts = SCHEME_AND_REST.exec(raw);
  if (!parts) return INVALID;
  const scheme = parts[1].toLowerCase();
  if (scheme === 'http') return { ok: false, reason: 'https_required' };
  if (scheme !== 'https' || FORBIDDEN_CHARACTERS.test(raw)) return INVALID;

  // Read from the text as typed: `URL` resolves dot segments and rewrites
  // backslashes, which would hide exactly what has to be refused.
  const slash = parts[2].indexOf('/');
  const authority = slash === -1 ? parts[2] : parts[2].slice(0, slash);
  const path = (slash === -1 ? '' : parts[2].slice(slash)).replace(/\/+$/, '');
  if (!authority || authority.includes('@')) return INVALID;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return INVALID;
  }
  // `URL` drops the default port, so anything left is another port.
  if (url.username || url.password || url.port) return INVALID;

  // Lower case and in its ASCII (punycode) form.
  const host = url.hostname;
  if (
    isIP(host) ||
    host.startsWith('[') ||
    host === 'localhost' ||
    host.length > HOST_MAX_LENGTH ||
    !host.includes('.') ||
    !host.split('.').every((label) => HOST_LABEL.test(label))
  )
    return INVALID;

  if (path) {
    const segments = path.split('/').slice(1);
    if (segments.some((segment) => !segment || /^\.{1,2}$/.test(segment)))
      return INVALID;
    const lowered = path.toLowerCase();
    if (RESERVED_PATH_PARTS.some((part) => lowered.includes(part)))
      return INVALID;
    // Anything `URL` would have rewritten is not a path Akeed stores.
    if (url.pathname.replace(/\/+$/, '') !== path) return INVALID;
  }

  const canonical = `https://${host}${path}`;
  return canonical.length > WOOCOMMERCE_STORE_URL_MAX_LENGTH
    ? INVALID
    : { ok: true, url: canonical };
}

/** The host of a canonical store URL: the only part of it that is logged. */
export function wooCommerceStoreHost(canonicalStoreUrl: string): string {
  return new URL(canonicalStoreUrl).hostname;
}
