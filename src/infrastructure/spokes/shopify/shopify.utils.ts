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
  query: Record<string, string>,
  secret: string,
): boolean {
  const { hmac, ...params } = query;

  // Sort params explicitly
  const queryString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  const calculatedHmac = crypto
    .createHmac('sha256', secret)
    .update(queryString)
    .digest('hex');

  // Constant-time comparison
  const hash1 = Buffer.from(calculatedHmac);
  const hash2 = Buffer.from(hmac);

  if (hash1.length !== hash2.length) {
    return false;
  }

  return crypto.timingSafeEqual(hash1, hash2);
}
