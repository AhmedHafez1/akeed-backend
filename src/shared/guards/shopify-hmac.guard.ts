import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { RequestWithRawBody } from '../models/request-with-raw-body.interface';

@Injectable()
export class ShopifyHmacGuard implements CanActivate {
  private readonly logger = new Logger(ShopifyHmacGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithRawBody>();
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string;

    if (!hmacHeader) {
      this.logger.warn('Missing X-Shopify-Hmac-Sha256 header');
      throw new UnauthorizedException('Missing X-Shopify-Hmac-Sha256 header');
    }

    const { rawBody } = req;
    if (!rawBody) {
      this.logger.warn(
        'Missing rawBody on request. Ensure rawBody is enabled in main.ts',
      );
      throw new UnauthorizedException('Internal Server Error: rawBody missing');
    }

    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) {
      this.logger.error(
        'SHOPIFY_API_SECRET is not defined in environment variables',
      );
      throw new UnauthorizedException(
        'Internal Server Error: Configuration missing',
      );
    }

    const hash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    // crypto.timingSafeEqual requires buffers of the same length
    // To safe guard against timing attacks, we can double HMAC ensuring we compare fixed length strings if we were doing string comparison
    // But timingSafeEqual wants Buffers.
    // Creating buffers from base64 strings

    const hashBuffer = Buffer.from(hash, 'base64');
    const headerBuffer = Buffer.from(hmacHeader, 'base64');

    if (hashBuffer.length !== headerBuffer.length) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    if (!crypto.timingSafeEqual(hashBuffer, headerBuffer)) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    return true;
  }
}
