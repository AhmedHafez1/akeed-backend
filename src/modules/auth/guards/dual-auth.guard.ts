import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenValidatorService } from '../services/token-validator.service';
import { Request } from 'express';
import { ALLOW_ORGLESS_KEY } from './orgless.decorator';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';

/**
 * Dual Authentication Guard
 *
 * This guard supports TWO authentication methods:
 * 1. Shopify Session Tokens (for embedded mode)
 * 2. Supabase JWTs (for standalone mode)
 *
 * Both authentication flows resolve to the SAME user and organization context.
 *
 * Request Context:
 * After successful authentication, the request object is decorated with:
 * ```
 * req.user = {
 *   userId: string,      // Unique user ID
 *   orgId: string,       // Organization ID
 *   source: 'shopify' | 'supabase',
 *   shop?: string,       // Only present for Shopify tokens
 * }
 * ```
 */

export interface AuthenticatedUser {
  userId: string;
  orgId: string;
  source: 'shopify' | 'supabase';
  shop?: string;
}

export interface RequestWithUser extends Request {
  user: AuthenticatedUser;
}

@Injectable()
export class DualAuthGuard implements CanActivate {
  private readonly logger = new Logger(DualAuthGuard.name);

  constructor(
    private readonly tokenValidator: TokenValidatorService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    // Extract Authorization header
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      this.logger.warn(
        buildBackendLog(DualAuthGuard.name, {
          action: 'token-validate',
          outcome: 'failure',
          requestId: this.getRequestId(request),
          errorCode: 'missing_authorization_header',
        }),
      );
      throw new UnauthorizedException('Missing authorization token');
    }

    // Extract token from "Bearer <token>" format
    const token = this.extractToken(authHeader);
    if (!token) {
      this.logger.warn(
        buildBackendLog(DualAuthGuard.name, {
          action: 'token-validate',
          outcome: 'failure',
          requestId: this.getRequestId(request),
          errorCode: 'invalid_authorization_header_format',
        }),
      );
      throw new UnauthorizedException('Invalid authorization format');
    }

    const allowOrgless = this.reflector.getAllAndOverride<boolean>(
      ALLOW_ORGLESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    try {
      // Validate token and get user context
      const user = await this.tokenValidator.validateToken(token, {
        allowMissingOrg: Boolean(allowOrgless),
      });

      // Attach user context to request
      request.user = user;

      this.logger.log(
        buildBackendLog(DualAuthGuard.name, {
          action: 'token-validate',
          outcome: 'success',
          requestId: this.getRequestId(request),
          userId: user.userId,
          orgId: user.orgId,
          shopDomain: user.shop,
          authSource: user.source,
        }),
      );

      return true;
    } catch (error) {
      this.logger.error(
        buildBackendLog(DualAuthGuard.name, {
          action: 'token-validate',
          outcome: 'failure',
          requestId: this.getRequestId(request),
          ...normalizeError(error),
        }),
      );
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private getRequestId(request: Request): string | undefined {
    const value = request.headers['x-request-id'];

    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  /**
   * Extract token from Authorization header
   */
  private extractToken(authHeader: string): string | null {
    const parts = authHeader.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return null;
    }

    return parts[1];
  }
}
