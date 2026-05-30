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
    const requestId = this.getRequestId(req);

    if (!signatureHeader) {
      this.logger.warn(
        buildBackendLog(MetaWebhookSignatureGuard.name, {
          action: 'meta-signature-verify',
          outcome: 'failure',
          requestId,
          errorCode: 'missing_meta_signature_header',
        }),
      );
      throw new UnauthorizedException('Missing X-Hub-Signature-256 header');
    }

    const { rawBody } = req;
    if (!rawBody) {
      this.logger.warn(
        buildBackendLog(MetaWebhookSignatureGuard.name, {
          action: 'meta-signature-verify',
          outcome: 'failure',
          requestId,
          errorCode: 'missing_raw_body',
        }),
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
      this.logger.warn(
        buildBackendLog(MetaWebhookSignatureGuard.name, {
          action: 'meta-signature-verify',
          outcome: 'failure',
          requestId,
          errorCode: 'signature_length_mismatch',
        }),
      );
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (!crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
      this.logger.warn(
        buildBackendLog(MetaWebhookSignatureGuard.name, {
          action: 'meta-signature-verify',
          outcome: 'failure',
          requestId,
          errorCode: 'signature_verification_failed',
        }),
      );
      throw new UnauthorizedException('Invalid webhook signature');
    }

    this.logger.log(
      buildBackendLog(MetaWebhookSignatureGuard.name, {
        action: 'meta-signature-verify',
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
