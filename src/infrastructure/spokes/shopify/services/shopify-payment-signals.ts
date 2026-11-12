/**
 * Payment evidence extraction for Shopify order payloads.
 *
 * Shopify reports how an order was paid in three places, and any of them may be
 * absent. Both the ingestion normalizer and the eligibility strategy need the
 * same walk, so it lives here once — reading an unvalidated payload, since the
 * eligibility path receives it as an opaque `rawPayload`.
 */
export function collectShopifyGatewaySignals(rawPayload: unknown): string[] {
  if (
    !rawPayload ||
    typeof rawPayload !== 'object' ||
    Array.isArray(rawPayload)
  ) {
    return [];
  }
  const payload = rawPayload as Record<string, unknown>;
  const signals: string[] = [];

  const gatewayNames = payload['payment_gateway_names'];
  if (Array.isArray(gatewayNames)) {
    for (const gatewayName of gatewayNames) {
      if (typeof gatewayName === 'string') signals.push(gatewayName);
    }
  }

  if (typeof payload['gateway'] === 'string') {
    signals.push(payload['gateway']);
  }

  const transactions = payload['transactions'];
  if (Array.isArray(transactions)) {
    for (const transaction of transactions) {
      if (
        !transaction ||
        typeof transaction !== 'object' ||
        Array.isArray(transaction)
      ) {
        continue;
      }
      const gateway = (transaction as Record<string, unknown>)['gateway'];
      if (typeof gateway === 'string') signals.push(gateway);
    }
  }

  return signals;
}

const MANUAL_GATEWAY = 'manual';
const UNPAID_FINANCIAL_STATUS = 'pending';

/**
 * Whether a Shopify order is cash on delivery although its gateway is the
 * generic `manual` one: COD order-form apps and orders created in the admin
 * report `manual` instead of the store's COD method. Only an order whose sole
 * gateway is `manual` and that is still unpaid (`pending`) counts. A paid
 * order, an order next to another gateway, or one without a financial status
 * stays non-COD. Named manual methods such as "Bank Deposit" are reported by
 * their own name, so they never match.
 */
export function isShopifyManualUnpaidCod(rawPayload: unknown): boolean {
  if (
    !rawPayload ||
    typeof rawPayload !== 'object' ||
    Array.isArray(rawPayload)
  ) {
    return false;
  }
  const payload = rawPayload as Record<string, unknown>;

  const gateways = new Set<string>();
  const addGateway = (value: unknown) => {
    if (typeof value !== 'string') return;
    const gateway = value.trim().toLowerCase();
    if (gateway) gateways.add(gateway);
  };
  const gatewayNames = payload['payment_gateway_names'];
  if (Array.isArray(gatewayNames)) gatewayNames.forEach(addGateway);
  addGateway(payload['gateway']);

  const financialStatus = payload['financial_status'];
  return (
    gateways.size === 1 &&
    gateways.has(MANUAL_GATEWAY) &&
    typeof financialStatus === 'string' &&
    financialStatus.trim().toLowerCase() === UNPAID_FINANCIAL_STATUS
  );
}
