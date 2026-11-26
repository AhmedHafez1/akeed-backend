import type { TemplateLanguage } from '../../shared/messaging/template-registry.types';

/**
 * What a Track order link opens. `redirect` sends the customer to a stored
 * carrier or courier page; `page` is Akeed's own page in the message's
 * language; `unavailable` is a code that is unknown or too old.
 */
export type ShippingTrackingView =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'page';
      language: TemplateLanguage;
      storeName: string | null;
      orderNumber: string | null;
      courier: string | null;
      trackingNumber: string | null;
    }
  | { kind: 'unavailable' };
