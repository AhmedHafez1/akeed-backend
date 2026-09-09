import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RequestWithRawBody } from '../../../shared/models/request-with-raw-body.interface';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import { readStandaloneCreditBillingConfig } from '../../../shared/config/standalone-credit-billing.config';
import { MalformedPaymobCallbackError, verifyPaymobHmac } from './paymob-hmac';

/** What a verified callback leaves on the request for the controller. */
export interface PaymobVerifiedRequest extends RequestWithRawBody {
  paymobEvent?: { type: string; obj: Record<string, unknown> };
}

/**
 * Verifies the processed-callback HMAC before anything reads the payload.
 *
 * Nothing downstream re-checks authenticity, so this is the whole trust
 * boundary for money arriving from Paymob. It runs on the raw body Nest keeps
 * for exactly this purpose, not on the parsed one, because a re-serialized body
 * is no longer the bytes the provider sent.
 */
@Injectable()
export class PaymobHmacGuard implements CanActivate {
  private readonly logger = new Logger(PaymobHmacGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<
        PaymobVerifiedRequest & { query?: Record<string, unknown> }
      >();
    const requestId = requestIdOf(request);

    // Logged before verification so "Paymob never called" and "Paymob called
    // and we rejected it" are distinguishable. A silent rejection makes the
    // callback look dead from both ends.
    this.logger.log(
      buildBackendLog(PaymobHmacGuard.name, {
        action: 'paymob-callback-received',
        outcome: 'success',
        requestId,
      }),
    );

    const billing = readStandaloneCreditBillingConfig(this.config);
    if (!billing.enabled) this.reject(requestId, 'billing_disabled');

    const { rawBody } = request;
    if (!rawBody?.length) this.reject(requestId, 'missing_raw_body');

    let envelope: { type?: unknown; obj?: unknown };
    try {
      envelope = JSON.parse(rawBody.toString('utf8')) as typeof envelope;
    } catch {
      return this.reject(requestId, 'unparseable_body');
    }
    const transaction = envelope.obj;
    if (transaction === null || typeof transaction !== 'object')
      this.reject(requestId, 'missing_transaction_object');

    const secret = billing.enabled ? billing.paymob.hmacSecret : '';
    let verified = false;
    try {
      verified = verifyPaymobHmac(
        transaction as Record<string, unknown>,
        request.query?.hmac,
        secret,
      );
    } catch (error) {
      // A payload missing a signed field cannot be verified at all; it is a
      // malformed callback, never an authentic one.
      return this.reject(
        requestId,
        error instanceof MalformedPaymobCallbackError
          ? 'malformed_signed_field'
          : 'signature_verification_error',
      );
    }
    if (!verified) this.reject(requestId, 'signature_verification_failed');

    request.paymobEvent = {
      type: typeof envelope.type === 'string' ? envelope.type : 'unknown',
      obj: transaction as Record<string, unknown>,
    };
    this.logger.log(
      buildBackendLog(PaymobHmacGuard.name, {
        action: 'paymob-callback-verify',
        outcome: 'success',
        requestId,
      }),
    );
    return true;
  }

  private reject(requestId: string | undefined, errorCode: string): never {
    this.logger.error(
      buildBackendLog(PaymobHmacGuard.name, {
        action: 'paymob-callback-verify',
        outcome: 'failure',
        requestId,
        errorCode,
      }),
    );
    throw new UnauthorizedException('Invalid Paymob callback signature');
  }
}

function requestIdOf(request: {
  headers: Record<string, unknown>;
}): string | undefined {
  const value = request.headers['x-request-id'];
  if (Array.isArray(value))
    return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}
