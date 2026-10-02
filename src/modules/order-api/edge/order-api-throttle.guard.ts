import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InjectThrottlerStorage,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Response } from 'express';
import {
  ORDER_API_RATE_WINDOW_MS,
  readOrderApiConfig,
  type OrderApiConfig,
} from '../../../shared/config/order-api.config';
import type { RequestWithIntegrationApiKey } from '../../integration-keys/integration-api-key.principal';
import { orderApiError } from './order-api.errors';

const THROTTLER_NAME = 'order-api';

/**
 * Counts one request against a bucket. Returns the seconds to wait when the
 * bucket is blocked, otherwise `null`.
 */
async function consume(
  storage: ThrottlerStorage,
  key: string,
  limit: number,
): Promise<number | null> {
  const bucket = `${THROTTLER_NAME}:${key}`;
  const record = await storage.increment(
    bucket,
    ORDER_API_RATE_WINDOW_MS,
    limit,
    ORDER_API_RATE_WINDOW_MS,
    // The in-memory storage keeps its expiry timers per throttler name and
    // cancels all of them when one key of that name leaves its block. A name
    // shared by every bucket would freeze the counts of the other
    // integrations and of the global bucket, so each bucket is its own name.
    bucket,
  );
  return record.isBlocked ? Math.max(1, record.timeToBlockExpire) : null;
}

function refuse(context: ExecutionContext, retryAfterSeconds: number): never {
  context
    .switchToHttp()
    .getResponse<Response>()
    .header('Retry-After', String(retryAfterSeconds));
  throw orderApiError('API_RATE_LIMITED');
}

/**
 * The ceiling on requests that have not proved who they are (US-05-04).
 *
 * The order API skips the app-wide IP throttler, because its limit would cap
 * a legitimate server and its 429 has no code. Without this guard a request
 * with a bad or missing key would be unlimited, and each one costs a key
 * lookup. It counts by client address and runs before the key guard.
 */
@Injectable()
export class OrderApiIngressThrottleGuard implements CanActivate {
  private readonly limits: OrderApiConfig;

  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    config: ConfigService,
  ) {
    this.limits = readOrderApiConfig(config);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithIntegrationApiKey>();
    const blockedFor = await consume(
      this.storage,
      `ip:${request.ip ?? 'unknown'}`,
      this.limits.preAuthPerIpPerMinute,
    );
    if (blockedFor !== null) refuse(context, blockedFor);
    return true;
  }
}

/**
 * The request limits of an authenticated integration (US-05-04).
 *
 * It runs right after the key guard, on the app's shared throttler storage,
 * and before validation or the ingestion command, so a throttled request
 * creates no order, event or credit hold. The bucket is the integration, not
 * the key: rotating or adding keys does not buy more requests. The global
 * bucket is counted only for requests the integration bucket let through, so
 * one noisy integration cannot spend everyone's budget.
 *
 * The storage is in memory, which is correct for one backend instance.
 * Running more than one needs Redis-backed storage first.
 */
@Injectable()
export class OrderApiThrottleGuard implements CanActivate {
  private readonly limits: OrderApiConfig;

  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    config: ConfigService,
  ) {
    this.limits = readOrderApiConfig(config);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const principal = context
      .switchToHttp()
      .getRequest<RequestWithIntegrationApiKey>().integrationApiKey;
    if (!principal)
      throw new Error(
        'OrderApiThrottleGuard used before IntegrationApiKeyGuard',
      );

    const blockedFor =
      (await consume(
        this.storage,
        principal.integrationId,
        this.limits.perIntegrationPerMinute,
      )) ??
      (await consume(this.storage, 'global', this.limits.globalPerMinute));
    if (blockedFor !== null) refuse(context, blockedFor);
    return true;
  }
}
