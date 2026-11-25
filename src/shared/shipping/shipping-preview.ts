import {
  SHIPPING_SHIPPED_PURPOSE,
  type RegistryTemplate,
  type TemplateLanguage,
} from '../messaging/template-registry.types';
import { shippingTrackingLine } from './shipping-tracking-line';

/** The tracking number shown in a Settings preview; never a real order's. */
export const SHIPPING_PREVIEW_TRACKING_NUMBER = '1Z999AA10123456784';

/**
 * The Shipped template a merchant previews in a language: the active default,
 * whatever its review status. Sending stays stricter and waits for approval
 * (`selectShippingTemplate`); a preview only shows the text.
 */
export function shippingPreviewTemplate(
  templates: readonly RegistryTemplate[],
  language: TemplateLanguage,
): RegistryTemplate | null {
  return (
    templates.find(
      (template) =>
        template.purpose === SHIPPING_SHIPPED_PURPOSE &&
        template.language === language &&
        template.isDefault &&
        template.isActive &&
        !template.changeRequestOfKey,
    ) ?? null
  );
}

/** The `{{tracking}}` line of a preview, as an order with tracking sends it. */
export function shippingPreviewTrackingLine(
  language: TemplateLanguage,
): string {
  return shippingTrackingLine(language, {
    number: SHIPPING_PREVIEW_TRACKING_NUMBER,
  });
}
