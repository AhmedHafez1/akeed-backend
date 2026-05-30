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

/**
 * Guard that verifies the X-Hub-Signature-256 header on incoming
 * Meta (WhatsApp) webhook POST requests using HMAC-SHA256.
 */
@Injectable()
export class MetaWebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(MetaWebhookSignatureGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithRawBody>();
    const signatureHeader = req.headers['x-hub-signature-256'] as string;

    if (!signatureHeader) {
      this.logger.warn('Missing X-Hub-Signature-256 header');
      throw new UnauthorizedException('Missing X-Hub-Signature-256 header');
    }

    const { rawBody } = req;
    if (!rawBody) {
      this.logger.warn(
        'Missing rawBody on request. Ensure rawBody is enabled in main.ts',
      );
      throw new UnauthorizedException('Internal Server Error: rawBody missing');
    }

    const appSecret = this.configService.getOrThrow<string>('META_APP_SECRET');

    const expectedSignature =
      'sha256=' +
      crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const receivedBuffer = Buffer.from(signatureHeader, 'utf8');

    if (expectedBuffer.length !== receivedBuffer.length) {
      this.logger.warn('Meta webhook signature length mismatch');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (!crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
      this.logger.warn('Meta webhook signature verification failed');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true;
  }
}
