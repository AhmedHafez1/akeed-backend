import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';
import {
  AuthenticatedRequestUser,
  AuthenticatedUser,
} from '../guards/dual-auth.guard';
import { IntegrationsRepository } from '../../../infrastructure/database/repositories/integrations.repository';
import { MembershipsRepository } from '../../../infrastructure/database/repositories/memberships.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import { isOrganizationRole } from '../organization-role';

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

export interface AuthenticatedAdmin {
  userId: string;
  role: 'admin';
  aal: string;
  source: 'supabase';
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
  ): Promise<AuthenticatedRequestUser> {
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

  async validateAdminToken(token: string): Promise<AuthenticatedAdmin> {
    if (this.detectTokenType(token) !== 'supabase') {
      throw new ForbiddenException('Admin access requires Supabase auth');
    }

    const {
      data: { user },
      error,
    } = await this.supabase.auth.getUser(token);

    if (error || !user) {
      throw new UnauthorizedException('Invalid Supabase token');
    }

    if (user.app_metadata?.akeed_role !== 'admin') {
      throw new ForbiddenException('Staff role required');
    }

    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { aal?: string };
    const requireAal2 =
      this.configService.get<string>('ADMIN_REQUIRE_AAL2') === 'true' ||
      (this.configService.get<string>('ADMIN_REQUIRE_AAL2') !== 'false' &&
        this.configService.get<string>('NODE_ENV') === 'production');

    if (requireAal2 && payload.aal !== 'aal2') {
      throw new ForbiddenException('Multi-factor authentication required');
    }

    return {
      userId: user.id,
      role: 'admin',
      aal: payload.aal ?? 'aal1',
      source: 'supabase',
    };
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
      this.logger.error(
        buildBackendLog(TokenValidatorService.name, {
          action: 'token-type-detect',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
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
      const shop = payload.dest.replace('https://', '');

      // Find integration by shop domain
      const integration = await this.integrationsRepo.findByPlatformDomain(
        shop,
        'shopify',
      );

      if (!integration || !integration.isActive) {
        this.logger.warn(
          buildBackendLog(TokenValidatorService.name, {
            action: 'token-validate-shopify',
            outcome: 'failure',
            shopDomain: shop,
            reason: integration
              ? 'integration_inactive'
              : 'integration_not_found',
          }),
        );
        throw new UnauthorizedException('Shop not registered');
      }

      const orgId = integration.orgId;

      // Find user membership
      // For Shopify, we use the shop domain to identify the user
      const membership = await this.membershipsRepo.findByOrg(orgId);

      if (!membership || membership.length === 0) {
        this.logger.warn(
          buildBackendLog(TokenValidatorService.name, {
            action: 'token-validate-shopify',
            outcome: 'failure',
            orgId,
            shopDomain: shop,
            reason: 'membership_not_found',
          }),
        );
        throw new UnauthorizedException('User not found');
      }

      // Use the first owner membership (typically created during OAuth)
      const ownerMembership = membership.find((m) => m.role === 'owner');
      const selectedMembership = ownerMembership ?? membership[0];
      if (!isOrganizationRole(selectedMembership.role)) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Organization membership role is invalid',
          code: 'ORGANIZATION_ROLE_INVALID',
        });
      }

      return {
        userId: selectedMembership.userId,
        orgId,
        role: selectedMembership.role,
        source: 'shopify',
        shop,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(
        buildBackendLog(TokenValidatorService.name, {
          action: 'token-validate-shopify',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
      throw new UnauthorizedException('Invalid Shopify session token');
    }
  }

  /**
   * Validate Supabase JWT
   */
  private async validateSupabaseToken(
    token: string,
    allowMissingOrg = false,
  ): Promise<AuthenticatedRequestUser> {
    try {
      // Verify JWT with Supabase
      const {
        data: { user },
        error,
      } = await this.supabase.auth.getUser(token);

      if (error || !user) {
        this.logger.warn(
          buildBackendLog(TokenValidatorService.name, {
            action: 'token-validate-supabase',
            outcome: 'failure',
            reason: 'supabase_user_lookup_failed',
            errorMessage: error?.message,
          }),
        );
        throw new UnauthorizedException('Invalid Supabase token');
      }

      const userId = user.id;

      // Find user's organization via membership
      const memberships = await this.membershipsRepo.findByUser(userId);

      if (!memberships || memberships.length === 0) {
        if (allowMissingOrg) {
          this.logger.log(
            buildBackendLog(TokenValidatorService.name, {
              action: 'token-validate-supabase',
              outcome: 'success',
              userId,
              reason: 'orgless_identity_allowed',
            }),
          );
          return {
            userId,
            orgId: null,
            role: null,
            source: 'supabase',
          };
        }

        this.logger.warn(
          buildBackendLog(TokenValidatorService.name, {
            action: 'token-validate-supabase',
            outcome: 'failure',
            userId,
            reason: 'organization_not_found',
          }),
        );
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Authenticated user has no organization',
          code: 'ORGANIZATION_REQUIRED',
        });
      }

      // Use the first organization (in future, support org switching)
      const selectedMembership = memberships[0];
      if (!isOrganizationRole(selectedMembership.role)) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Organization membership role is invalid',
          code: 'ORGANIZATION_ROLE_INVALID',
        });
      }

      return {
        userId,
        orgId: selectedMembership.orgId,
        role: selectedMembership.role,
        source: 'supabase',
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(
        buildBackendLog(TokenValidatorService.name, {
          action: 'token-validate-supabase',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
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

    const signatureBuffer = Buffer.from(signatureB64, 'base64url');
    const expectedSignatureBuffer = Buffer.from(expectedSignature, 'base64url');

    if (signatureBuffer.length !== expectedSignatureBuffer.length) {
      this.logger.error(
        buildBackendLog(TokenValidatorService.name, {
          action: 'token-verify-shopify-jwt-signature',
          outcome: 'failure',
          reason: 'signature_length_mismatch',
        }),
      );
      throw new Error('Invalid JWT signature');
    }

    if (!crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) {
      this.logger.error(
        buildBackendLog(TokenValidatorService.name, {
          action: 'token-verify-shopify-jwt-signature',
          outcome: 'failure',
          reason: 'invalid_signature',
        }),
      );
      throw new Error('Invalid JWT signature');
    }

    // Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      this.logger.error(
        buildBackendLog(TokenValidatorService.name, {
          action: 'token-verify-shopify-jwt-claims',
          outcome: 'failure',
          reason: 'token_expired',
          exp: payload.exp,
          now,
        }),
      );
      throw new Error('JWT expired');
    }

    // Verify not before
    if (payload.nbf > now) {
      this.logger.error(
        buildBackendLog(TokenValidatorService.name, {
          action: 'token-verify-shopify-jwt-claims',
          outcome: 'failure',
          reason: 'token_not_yet_valid',
          nbf: payload.nbf,
          now,
        }),
      );
      throw new Error('JWT not yet valid');
    }

    // Verify audience (API key)
    const apiKey = this.configService.getOrThrow<string>('SHOPIFY_API_KEY');
    if (payload.aud !== apiKey) {
      this.logger.error(
        buildBackendLog(TokenValidatorService.name, {
          action: 'token-verify-shopify-jwt-claims',
          outcome: 'failure',
          reason: 'audience_mismatch',
          shopDomain: payload.dest ?? 'unknown',
        }),
      );
      throw new Error('Invalid JWT audience');
    }

    return payload;
  }
}
