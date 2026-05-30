import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { RequestWithRawBody } from '../models/request-with-raw-body.interface';
import { buildBackendLog } from '../logging/backend-log.util';

@Injectable()
export class ShopifyHmacGuard implements CanActivate {
  private readonly logger = new Logger(ShopifyHmacGuard.name);

  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithRawBody>();
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string;
    const requestId = this.getRequestId(req);

    if (!hmacHeader) {
      this.logger.warn(
        buildBackendLog(ShopifyHmacGuard.name, {
          action: 'shopify-hmac-verify',
          outcome: 'failure',
          requestId,
          errorCode: 'missing_shopify_hmac_header',
        }),
      );
      throw new UnauthorizedException('Missing X-Shopify-Hmac-Sha256 header');
    }

    const { rawBody } = req;
    if (!rawBody) {
      this.logger.warn(
        buildBackendLog(ShopifyHmacGuard.name, {
          action: 'shopify-hmac-verify',
          outcome: 'failure',
          requestId,
          errorCode: 'missing_raw_body',
        }),
      );
      throw new UnauthorizedException('Internal Server Error: rawBody missing');
    }

    const secret = this.configService.getOrThrow<string>('SHOPIFY_API_SECRET');

    const generatedHash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    const hmacBuffer = Buffer.from(hmacHeader, 'base64');
    const generatedHashBuffer = Buffer.from(generatedHash, 'base64');

    if (hmacBuffer.length !== generatedHashBuffer.length) {
      this.logger.warn(
        buildBackendLog(ShopifyHmacGuard.name, {
          action: 'shopify-hmac-verify',
          outcome: 'failure',
          requestId,
          errorCode: 'hmac_length_mismatch',
        }),
      );
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    if (!crypto.timingSafeEqual(hmacBuffer, generatedHashBuffer)) {
      this.logger.warn(
        buildBackendLog(ShopifyHmacGuard.name, {
          action: 'shopify-hmac-verify',
          outcome: 'failure',
          requestId,
          errorCode: 'invalid_hmac_signature',
        }),
      );
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    this.logger.log(
      buildBackendLog(ShopifyHmacGuard.name, {
        action: 'shopify-hmac-verify',
        outcome: 'success',
        requestId,
      }),
    );

    return true;
  }

  private getRequestId(req: RequestWithRawBody): string | undefined {
    const value = req.headers['x-request-id'];

    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }
}
