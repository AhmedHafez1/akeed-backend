/**
 * What only the EasyOrders install adds to the shared install tokens
 * (`shared/commerce/install-token.ts`; US-06-02, contract record sections 1
 * and 6).
 */
const HINT_LENGTH = 6;

/**
 * The last characters of a webhook URL token. The seller sees the whole URL
 * in their EasyOrders dashboard; the hint lets them find the right row there.
 */
export function installTokenHint(token: string): string {
  return token.slice(-HINT_LENGTH);
}
