import * as crypto from 'crypto';

export function validateShop(shop: string): boolean {
  if (!shop) return false;
  const regex = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
  return regex.test(shop);
}

export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function verifyShopifyHmac(
  query: Record<string, string | undefined>,
  secret: string,
): boolean {
  if (!query.hmac) return false;

  // Build message from all params except hmac/signature, preserving URL encoding
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(query)) {
    if (key === 'hmac' || key === 'signature') continue;
    if (value === undefined) continue;
    entries.push([key, value]);
  }

  const queryString = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join('&');

  const calculatedHmac = crypto
    .createHmac('sha256', secret)
    .update(queryString)
    .digest('hex')
    .toLowerCase();

  const receivedHmac = query.hmac.toLowerCase();
  if (calculatedHmac.length !== receivedHmac.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(calculatedHmac, 'hex'),
    Buffer.from(receivedHmac, 'hex'),
  );
}
