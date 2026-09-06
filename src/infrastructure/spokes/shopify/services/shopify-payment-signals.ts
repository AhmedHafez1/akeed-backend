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
