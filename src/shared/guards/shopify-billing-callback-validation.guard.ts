import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  validateShop,
  verifyShopifyHmac,
} from '../../infrastructure/spokes/shopify/shopify.utils';

interface BillingCallbackQuery {
  shop?: string | string[];
  charge_id?: string | string[];
  hmac?: string | string[];
  signature?: string | string[];
  host?: string | string[];
  [key: string]: string | string[] | undefined;
}

@Injectable()
export class ShopifyBillingCallbackValidationGuard implements CanActivate {
  private readonly logger = new Logger(
    ShopifyBillingCallbackValidationGuard.name,
  );

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const query = req.query as unknown as BillingCallbackQuery;

    const shop = this.getSingleQueryParam(query.shop);
    const chargeId = this.getSingleQueryParam(query.charge_id);
    const hmac = this.getSingleQueryParam(query.hmac);

    if (!shop || !chargeId) {
      throw new BadRequestException(
        'Missing required Shopify billing callback parameters',
      );
    }

    if (!validateShop(shop)) {
      throw new BadRequestException('Invalid shop parameter');
    }

    // Shopify billing return URLs may omit hmac in some approval flows.
    // When present, we always verify and reject invalid signatures.
    if (hmac) {
      const normalizedQuery = this.normalizeQuery(query);
      const secret =
        this.configService.getOrThrow<string>('SHOPIFY_API_SECRET');
      if (!verifyShopifyHmac(normalizedQuery, secret)) {
        throw new UnauthorizedException(
          'Invalid Shopify billing callback signature',
        );
      }
    } else {
      this.logger.warn(
        `Shopify billing callback arrived without hmac (shop=${shop}, charge_id=${chargeId}); allowing and relying on charge status verification.`,
      );
    }

    return true;
  }

  private getSingleQueryParam(
    value: string | string[] | undefined,
  ): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value) && value.length > 0) {
      return value[0];
    }

    return undefined;
  }

  private normalizeQuery(
    query: BillingCallbackQuery,
  ): Record<string, string | undefined> {
    const normalized: Record<string, string | undefined> = {};

    for (const [key, value] of Object.entries(query)) {
      normalized[key] = this.getSingleQueryParam(value);
    }

    return normalized;
  }
}
