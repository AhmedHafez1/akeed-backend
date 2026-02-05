import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';
import { AuthenticatedUser } from '../guards/dual-auth.guard';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { MembershipsRepository } from '../../infrastructure/database/repositories/memberships.repository';

/**
 * Token Validator Service
 *
 * Validates tokens from both authentication sources:
 * 1. Shopify Session Tokens (JWT issued by Shopify)
 * 2. Supabase JWTs (JWT issued by Supabase Auth)
 *
 * Both flows must resolve to consistent user and organization IDs.
 */

interface ShopifySessionPayload {
  iss: string; // Issuer (shop domain)
  dest: string; // Destination (shop domain)
  aud: string; // Audience (API key)
  sub: string; // Subject (user ID)
  exp: number; // Expiration
  nbf: number; // Not before
  iat: number; // Issued at
  jti: string; // JWT ID
  sid: string; // Session ID
}

@Injectable()
export class TokenValidatorService {
  private readonly logger = new Logger(TokenValidatorService.name);
  private readonly supabase: SupabaseClient<any, 'public', any>;

  constructor(
    private readonly configService: ConfigService,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly membershipsRepo: MembershipsRepository,
  ) {
    // Initialize Supabase client
    const supabaseUrl = this.configService.getOrThrow<string>('SUPABASE_URL');
    const supabaseServiceKey = this.configService.getOrThrow<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );

    this.supabase = createClient<any, 'public', any>(
      supabaseUrl,
      supabaseServiceKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }

  /**
   * Main validation entry point
   * Detects token type and validates accordingly
   */
  async validateToken(
    token: string,
    options?: { allowMissingOrg?: boolean },
  ): Promise<AuthenticatedUser> {
    // Detect token type
    const tokenType = this.detectTokenType(token);

    if (tokenType === 'shopify') {
      return this.validateShopifyToken(token);
    } else if (tokenType === 'supabase') {
      return this.validateSupabaseToken(token, options?.allowMissingOrg);
    } else {
      throw new UnauthorizedException('Unknown token type');
    }
  }

  /**
   * Detect token type based on JWT structure
   */
  private detectTokenType(token: string): 'shopify' | 'supabase' | 'unknown' {
    try {
      // Decode JWT without verification to inspect payload
      const parts = token.split('.');
      if (parts.length !== 3) {
        return 'unknown';
      }

      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8'),
      ) as { dest?: string; aud?: string; role?: string };

      // Shopify tokens have 'dest' field
      if (payload.dest && payload.dest.includes('myshopify.com')) {
        return 'shopify';
      }

      // Supabase tokens have 'aud' as 'authenticated'
      if (payload.aud === 'authenticated' || payload.role === 'authenticated') {
        return 'supabase';
      }

      return 'unknown';
    } catch (error) {
      this.logger.error('Failed to detect token type', error);
      return 'unknown';
    }
  }

  /**
   * Validate Shopify Session Token
   */
  private async validateShopifyToken(
    token: string,
  ): Promise<AuthenticatedUser> {
    try {
      // Decode and verify Shopify JWT
      const payload = this.verifyShopifyJWT(token);

      // Extract shop domain
      const shop = payload.dest;

      // Find integration by shop domain
      const integration = await this.integrationsRepo.findByPlatformDomain(
        shop,
        'shopify',
      );

      if (!integration) {
        this.logger.warn(`No integration found for shop: ${shop}`);
        throw new UnauthorizedException('Shop not registered');
      }

      const orgId = integration.orgId;

      // Find user membership
      // For Shopify, we use the shop domain to identify the user
      const membership = await this.membershipsRepo.findByOrg(orgId);

      if (!membership || membership.length === 0) {
        this.logger.warn(`No membership found for org: ${orgId}`);
        throw new UnauthorizedException('User not found');
      }

      // Use the first owner membership (typically created during OAuth)
      const ownerMembership = membership.find((m) => m.role === 'owner');
      const userId = ownerMembership?.userId || membership[0].userId;

      return {
        userId,
        orgId,
        source: 'shopify',
        shop,
      };
    } catch (error) {
      this.logger.error('Shopify token validation failed', error);
      throw new UnauthorizedException('Invalid Shopify session token');
    }
  }

  /**
   * Validate Supabase JWT
   */
  private async validateSupabaseToken(
    token: string,
    allowMissingOrg = false,
  ): Promise<AuthenticatedUser> {
    try {
      // Verify JWT with Supabase
      const {
        data: { user },
        error,
      } = await this.supabase.auth.getUser(token);

      if (error || !user) {
        this.logger.warn(`Supabase token validation failed: ${error?.message}`);
        throw new UnauthorizedException('Invalid Supabase token');
      }

      const userId = user.id;

      // Find user's organization via membership
      const memberships = await this.membershipsRepo.findByUser(userId);

      if (!memberships || memberships.length === 0) {
        this.logger.warn(`No organization found for user: ${userId}`);
        if (allowMissingOrg) {
          return {
            userId,
            orgId: '',
            source: 'supabase',
          };
        }
        throw new UnauthorizedException('User has no organization');
      }

      // Use the first organization (in future, support org switching)
      const orgId = memberships[0].orgId;

      return {
        userId,
        orgId,
        source: 'supabase',
      };
    } catch (error) {
      this.logger.error('Supabase token validation failed', error);
      throw new UnauthorizedException('Invalid Supabase token');
    }
  }

  /**
   * Verify Shopify JWT signature
   *
   * Shopify session tokens are signed with HMAC SHA-256
   * using the app's client secret
   */
  private verifyShopifyJWT(token: string): ShopifySessionPayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode payload
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as ShopifySessionPayload;

    // Verify signature
    const secret = this.configService.getOrThrow<string>('SHOPIFY_API_SECRET');
    const data = `${headerB64}.${payloadB64}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('base64url');

    if (signatureB64 !== expectedSignature) {
      throw new Error('Invalid JWT signature');
    }

    // Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      throw new Error('JWT expired');
    }

    // Verify not before
    if (payload.nbf > now) {
      throw new Error('JWT not yet valid');
    }

    // Verify audience (API key)
    const apiKey = this.configService.getOrThrow<string>('SHOPIFY_API_KEY');
    if (payload.aud !== apiKey) {
      throw new Error('Invalid JWT audience');
    }

    return payload;
  }
}
