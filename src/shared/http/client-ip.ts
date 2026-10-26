import type { Request } from 'express';

/**
 * The visitor's address: the first `x-forwarded-for` hop when the platform
 * proxy set one, otherwise the socket peer. Good enough for rate-limit keys
 * and ad matching; never use it as an authorization signal.
 */
export function getClientIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0]?.trim();
  }
  const connection = req.connection as { remoteAddress?: string } | undefined;
  return (req.ip ?? connection?.remoteAddress)?.trim();
}
