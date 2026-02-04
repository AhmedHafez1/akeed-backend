import { Injectable, Logger } from '@nestjs/common';
import { OrganizationsRepository } from 'src/infrastructure/database/repositories/organizations.repository';
import type { AuthenticatedUser } from '../guards/dual-auth.guard';
import { AuthStatusResponseDto, MeResponseDto } from '../dto/auth.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly organizationsRepo: OrganizationsRepository) {}

  async getCurrentUser(user: AuthenticatedUser): Promise<MeResponseDto> {
    this.logger.debug(
      `GET /auth/me - user: ${user.userId}, org: ${user.orgId}, source: ${user.source}`,
    );

    const organization = await this.organizationsRepo.findById(user.orgId);

    if (!organization) {
      this.logger.warn(`Organization not found: ${user.orgId}`);
      return {
        user_id: user.userId,
        org_id: user.orgId,
        source: user.source,
        shop: user.shop,
      };
    }

    const response: MeResponseDto = {
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

    if (user.shop) {
      response.shop = user.shop;
    }

    return response;
  }

  getAuthStatus(user: AuthenticatedUser): AuthStatusResponseDto {
    return {
      authenticated: true,
      source: user.source,
    };
  }
}
