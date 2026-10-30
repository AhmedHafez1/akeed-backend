import { PhoneService } from '../../../../shared/services/phone.service';
import type { ShopifyCustomerKeys } from '../../../database/repositories/orders.repository';

interface ShopifyGdprCustomer {
  id?: string | number | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * The keys a Shopify GDPR request names a customer by. Shopify often sends a
 * customer with no phone, and an order's phone usually comes from its address,
 * so the customer id, email and order ids each match on their own. The phone
 * is tried as sent and in the E.164 form orders store.
 */
export function buildShopifyCustomerKeys(
  customer: ShopifyGdprCustomer | undefined,
  orderIds: Array<string | number> | undefined,
  phoneService: PhoneService,
): ShopifyCustomerKeys {
  const customerId =
    customer?.id === undefined || customer?.id === null
      ? ''
      : String(customer.id).trim();
  const email = customer?.email?.trim() ?? '';
  const rawPhone = customer?.phone?.trim() ?? '';

  const phones = new Set<string>();
  if (rawPhone) {
    phones.add(rawPhone);
    const parsed = phoneService.parse(rawPhone);
    if (parsed.ok) {
      phones.add(parsed.e164);
    }
  }

  return {
    customerId: customerId || undefined,
    email: email || undefined,
    phones: [...phones],
    externalOrderIds: [
      ...new Set(
        (orderIds ?? []).map((id) => String(id).trim()).filter(Boolean),
      ),
    ],
  };
}
