import {
  HttpException,
  Injectable,
  PayloadTooLargeException,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  InjectThrottlerStorage,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import type { RequestWithUser } from '../auth/guards/dual-auth.guard';
import { LOGO_MAX_BYTES } from './logo-banner.policy';
import { logoError } from './merchant-branding.errors';

function isFileSizeLimit(error: unknown): boolean {
  return (
    error instanceof PayloadTooLargeException ||
    (error as { code?: unknown } | null)?.code === 'LIMIT_FILE_SIZE'
  );
}

/**
 * Reads the one `logo` part into memory. Multer stops at the size limit
 * instead of buffering the whole body; its refusals become logo codes.
 */
@Injectable()
export class LogoUploadInterceptor extends FileInterceptor('logo', {
  storage: memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 0, parts: 1 },
}) {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (isFileSizeLimit(error)) throw logoError('LOGO_FILE_TOO_LARGE');
      if (error instanceof HttpException && error.getStatus() >= 500)
        throw error;
      throw logoError('LOGO_FILE_REQUIRED');
    }
  }
}

export const LOGO_UPLOADS_PER_MINUTE = 5;
const WINDOW_MS = 60_000;
const THROTTLER_NAME = 'logo-upload';

/**
 * 5 uploads a minute per user, counted after authentication like the order
 * import upload, and answered with `LOGO_RATE_LIMITED`.
 */
@Injectable()
export class LogoUploadThrottleGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const { user } = http.getRequest<RequestWithUser>();
    const record = await this.storage.increment(
      `${THROTTLER_NAME}:${user.userId}`,
      WINDOW_MS,
      LOGO_UPLOADS_PER_MINUTE,
      WINDOW_MS,
      THROTTLER_NAME,
    );
    if (record.isBlocked) {
      http
        .getResponse<Response>()
        .header('Retry-After', String(record.timeToBlockExpire));
      throw logoError('LOGO_RATE_LIMITED');
    }
    return true;
  }
}
