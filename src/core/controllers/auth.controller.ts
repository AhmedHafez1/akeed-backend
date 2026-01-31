import { Controller, Get, UseGuards, Request, Logger } from '@nestjs/common';
import {
  DualAuthGuard,
  type AuthenticatedUser,
  type RequestWithUser,
} from '../guards/dual-auth.guard';
import { OrganizationsRepository } from 'src/infrastructure/database/repositories/organizations.repository';

/**
 * Auth Controller
 *
 * Provides authentication-related endpoints:
 * - GET /me - Returns current user context
 *
 * This endpoint is CRITICAL for the dual-mode architecture.
 * It must return identical structure regardless of authentication source.
 */

interface MeResponse {
  user_id: string;
  org_id: string;
  source: 'shopify' | 'supabase';
  shop?: string;
  organization?: {
    id: string;
    name: string;
    slug: string;
    plan_type: string;
  };
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly organizationsRepo: OrganizationsRepository) {}

  /**
   * GET /auth/me
   *
   * Returns current authenticated user context.
   * This endpoint is used by the frontend to:
   * 1. Verify authentication status
   * 2. Get user and organization IDs
   * 3. Determine authentication source
   *
   * Response is IDENTICAL regardless of auth source (Shopify vs Supabase)
   */
  @Get('me')
  @UseGuards(DualAuthGuard)
  async getCurrentUser(@Request() req: RequestWithUser): Promise<MeResponse> {
    const user: AuthenticatedUser = req.user;

    this.logger.debug(
      `GET /auth/me - user: ${user.userId}, org: ${user.orgId}, source: ${user.source}`,
    );

    // Fetch organization details
    const organization = await this.organizationsRepo.findById(user.orgId);

    if (!organization) {
      this.logger.warn(`Organization not found: ${user.orgId}`);
      // Return basic response even if org not found
      return {
        user_id: user.userId,
        org_id: user.orgId,
        source: user.source,
        shop: user.shop,
      };
    }

    // Build comprehensive response
    const response: MeResponse = {
      user_id: user.userId,
      org_id: user.orgId,
      source: user.source,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        plan_type: organization.planType || 'free',
      },
    };

    // Include shop domain for Shopify users
    if (user.shop) {
      response.shop = user.shop;
    }

    return response;
  }

  /**
   * GET /auth/status
   *
   * Simple health check for authentication
   * Returns 200 if authenticated, 401 if not
   */
  @Get('status')
  @UseGuards(DualAuthGuard)
  getAuthStatus(@Request() req: RequestWithUser): {
    authenticated: boolean;
    source: string;
  } {
    const user: AuthenticatedUser = req.user;

    return {
      authenticated: true,
      source: user.source,
    };
  }
}
