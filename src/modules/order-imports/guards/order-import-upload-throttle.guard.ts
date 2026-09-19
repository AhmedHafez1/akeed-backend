import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import {
  InjectThrottlerStorage,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Response } from 'express';
import type { RequestWithUser } from '../../auth/guards/dual-auth.guard';
import { orderImportError } from '../order-imports.errors';

export const ORDER_IMPORT_UPLOADS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;
const THROTTLER_NAME = 'order-import-upload';

/**
 * 10 uploads a minute per user (US-04.6-02).
 *
 * The app-wide throttler keys by IP and runs before authentication, so it
 * cannot count per user, and its 429 carries no code. The upload route skips
 * it and uses this guard instead, which runs right after authentication on
 * the same throttler storage and answers `IMPORT_RATE_LIMITED`.
 */
@Injectable()
export class OrderImportUploadThrottleGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const { user } = http.getRequest<RequestWithUser>();
    const record = await this.storage.increment(
      `${THROTTLER_NAME}:${user.userId}`,
      WINDOW_MS,
      ORDER_IMPORT_UPLOADS_PER_MINUTE,
      WINDOW_MS,
      THROTTLER_NAME,
    );
    if (record.isBlocked) {
      http
        .getResponse<Response>()
        .header('Retry-After', String(record.timeToBlockExpire));
      throw orderImportError('IMPORT_RATE_LIMITED', {
        retryAfterSeconds: record.timeToBlockExpire,
      });
    }
    return true;
  }
}
