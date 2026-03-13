import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from './guards/dual-auth.guard';
import { CurrentUser } from './guards/current-user.decorator';
import { AuthService } from './auth.service';
import { AuthStatusResponseDto, MeResponseDto } from './dto/auth.dto';

/**
 * Auth Controller
 *
 * Provides authentication-related endpoints:
 * - GET /me - Returns current user context
 *
 * This endpoint is CRITICAL for the dual-mode architecture.
 * It must return identical structure regardless of authentication source.
 */

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
  async getCurrentUser(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MeResponseDto> {
    return this.authService.getCurrentUser(user);
  }

  /**
   * GET /auth/status
   *
   * Simple health check for authentication
   * Returns 200 if authenticated, 401 if not
   */
  @Get('status')
  @UseGuards(DualAuthGuard)
  getAuthStatus(@CurrentUser() user: AuthenticatedUser): AuthStatusResponseDto {
    return this.authService.getAuthStatus(user);
  }
}
