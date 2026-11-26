import type { ShippingTrackingLinkKind } from './shipping-notification.types';

/**
 * Couriers whose public tracking page opens a shipment straight from a link
 * with the number in it. Each format was checked on the courier's own site
 * before it was added; a courier that could not be checked is left out and
 * its shipments show Akeed's page with the number instead.
 */
interface CourierTrackingPage {
  name: string;
  /** Names a store may send, matched without case, spaces or punctuation. */
  aliases: readonly string[];
  trackingUrl: (number: string) => string;
}

const COURIERS: readonly CourierTrackingPage[] = [
  {
    name: 'Bosta',
    aliases: ['bosta', 'بوسطة'],
    trackingUrl: (number) =>
      `https://bosta.co/en-eg/tracking-shipments?shipment-number=${number}`,
  },
  {
    name: 'Aramex',
    aliases: ['aramex', 'أرامكس', 'ارامكس'],
    trackingUrl: (number) =>
      `https://www.aramex.com/us/en/track/results?ShipmentNumber=${number}`,
  },
  {
    name: 'DHL Express',
    aliases: ['dhl', 'dhlexpress'],
    trackingUrl: (number) =>
      `https://www.dhl.com/eg-en/home/tracking.html?submit=1&tracking-id=${number}`,
  },
  {
    name: 'Yurtiçi Kargo',
    aliases: ['yurtici', 'yurtiçi', 'yurticikargo', 'yurtiçikargo'],
    trackingUrl: (number) =>
      `https://www.yurticikargo.com/tr/online-servisler/gonderi-sorgula?code=${number}`,
  },
];

function normalizeName(value: string): string {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('en')
    .replace(/[\s\-_.&,'’()]+/g, '');
}

const COURIER_BY_ALIAS = new Map<string, CourierTrackingPage>(
  COURIERS.flatMap((courier) =>
    courier.aliases.map((alias) => [normalizeName(alias), courier] as const),
  ),
);

/** The courier a store's carrier name stands for, when Akeed knows it. */
export function recognizeShippingCourier(
  company: string | null | undefined,
): CourierTrackingPage | null {
  if (!company) return null;
  return COURIER_BY_ALIAS.get(normalizeName(company)) ?? null;
}

/** Only an absolute `https:` link is ever a redirect target. */
function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export type ShippingTrackingLink =
  | {
      kind: 'carrier_link' | 'courier_page';
      url: string;
      courier: string | null;
    }
  | { kind: 'number_only' | 'none'; courier: string | null };

/**
 * What a shipment's Track order link opens. The store's own link always
 * wins; then a known courier's page built from the number; otherwise Akeed's
 * page. Every target comes from the stored shipment, never from a request.
 */
export function resolveShippingTrackingLink(tracking: {
  url?: string | null;
  company?: string | null;
  number?: string | null;
}): ShippingTrackingLink {
  const courier = recognizeShippingCourier(tracking.company);
  const courierName = courier?.name ?? tracking.company?.trim() ?? null;
  const carrierLink = httpsUrl(tracking.url);
  if (carrierLink) {
    return { kind: 'carrier_link', url: carrierLink, courier: courierName };
  }
  const number = tracking.number?.trim();
  if (number && courier) {
    const built = httpsUrl(courier.trackingUrl(encodeURIComponent(number)));
    if (built)
      return { kind: 'courier_page', url: built, courier: courierName };
  }
  return { kind: number ? 'number_only' : 'none', courier: courierName };
}

export function shippingTrackingLinkKind(tracking: {
  url?: string | null;
  company?: string | null;
  number?: string | null;
}): ShippingTrackingLinkKind {
  return resolveShippingTrackingLink(tracking).kind;
}
