import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { buildBackendLog } from '../logging/backend-log.util';

/**
 * A ceiling on payment callbacks, sized to leave provider retries alone.
 *
 * The global throttler allows 60 requests a minute across a whole IP, which a
 * legitimate settlement burst or a redelivery wave can exceed; the route opts
 * out of it and uses this instead. The limit is high enough that a provider
 * catching up is never refused, and low enough that an open endpoint cannot be
 * used to hammer the database.
 *
 * In-memory and per-instance, matching the existing Shopify billing callback
 * guard. That is a backstop against accidental volume, not a defence against a
 * distributed flood -- authenticity is the HMAC guard's job.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
const MAX_TRACKED_KEYS = 5_000;

@Injectable()
export class PaymentCallbackRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(PaymentCallbackRateLimitGuard.name);
  private readonly counters = new Map<
    string,
    { count: number; resetAt: number }
  >();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const key = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();
    this.prune(now);

    const counter = this.counters.get(key);
    if (!counter || counter.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    counter.count += 1;
    if (counter.count <= MAX_PER_WINDOW) return true;

    const retryAfter = Math.max(Math.ceil((counter.resetAt - now) / 1000), 1);
    this.logger.warn(
      buildBackendLog(PaymentCallbackRateLimitGuard.name, {
        action: 'payment-callback-rate-limit',
        outcome: 'skipped',
        errorCode: 'rate_limited',
        retryAfter,
      }),
    );
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: 'Too many payment callbacks.',
        retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Bounded memory: an endpoint reachable by anyone must not grow a map. */
  private prune(now: number): void {
    if (this.counters.size < MAX_TRACKED_KEYS) return;
    for (const [key, counter] of this.counters)
      if (counter.resetAt <= now) this.counters.delete(key);
  }
}
