import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { validateShop } from '../../infrastructure/spokes/shopify/shopify.utils';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

@Injectable()
export class BillingCallbackRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(BillingCallbackRateLimitGuard.name);
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(private readonly configService: ConfigService) {
    this.windowMs = this.readNumber(
      'SHOPIFY_BILLING_CALLBACK_RATE_LIMIT_WINDOW_MS',
      60_000,
    );
    this.maxRequests = this.readNumber(
      'SHOPIFY_BILLING_CALLBACK_RATE_LIMIT_MAX',
      30,
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const key = this.buildKey(req);
    const now = Date.now();

    if (this.store.size > 5_000) {
      for (const [entryKey, entry] of this.store.entries()) {
        if (entry.resetAt <= now) {
          this.store.delete(entryKey);
        }
      }
    }

    const entry = this.store.get(key);
    if (!entry || entry.resetAt <= now) {
      this.store.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    entry.count += 1;
    if (entry.count > this.maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((entry.resetAt - now) / 1000),
      );
      this.logger.warn(`Rate limit exceeded for billing callback (${key}).`);
      throw new Error(
        `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
      );
    }

    return true;
  }

  private buildKey(req: Request): string {
    const rawShop =
      typeof req.query?.shop === 'string' ? req.query.shop : undefined;
    const shop = rawShop?.trim().toLowerCase();
    if (shop && validateShop(shop)) {
      return `shop:${shop}`;
    }

    const ip = this.getClientIp(req) ?? 'unknown';
    return `ip:${ip}`;
  }

  private getClientIp(req: Request): string | undefined {
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

  private readNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return fallback;
  }
}
