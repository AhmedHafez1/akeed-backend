import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  isInterfaceLocale,
  type InterfaceLocale,
} from '../i18n/interface-locales';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`announcement-unsubscribe:${payload}`)
    .digest('base64url');
}
export function announcementUnsubscribeToken(
  orgId: string,
  locale: InterfaceLocale,
  secret: string,
): string {
  const payload = Buffer.from(`v1:${orgId}:${locale}`).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}
export function verifyAnnouncementUnsubscribeToken(
  token: string,
  secret: string,
): { orgId: string; locale: InterfaceLocale } | null {
  if (token.length > 256 || secret.length < 32) return null;
  const parts = token.split('.');
  if (
    parts.length !== 2 ||
    !/^[\w-]+$/.test(parts[0]) ||
    !/^[\w-]{43}$/.test(parts[1])
  )
    return null;
  const expected = Buffer.from(signature(parts[0], secret));
  const actual = Buffer.from(parts[1]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null;
  const [version, orgId, locale, extra] = Buffer.from(parts[0], 'base64url')
    .toString('utf8')
    .split(':');
  return version === 'v1' &&
    UUID.test(orgId ?? '') &&
    isInterfaceLocale(locale) &&
    extra === undefined
    ? { orgId, locale }
    : null;
}
