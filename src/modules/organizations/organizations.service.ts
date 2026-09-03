import {
  ForbiddenException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CreateOrganizationDto,
  OrganizationResponseDto,
  UpdateOrganizationDto,
} from './dto/organizations.dto';
import { OrganizationsRepository } from '../../infrastructure/database/repositories/organizations.repository';
import {
  StandaloneOrganizationProvisioningRepository,
  StandaloneOrganizationProvisioningResult,
  StandaloneSourceConflictError,
} from '../../infrastructure/database/repositories/standalone-organization-provisioning.repository';
import type { AuthenticatedRequestUser } from '../auth/guards/dual-auth.guard';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly organizationsRepo: OrganizationsRepository,
    private readonly standaloneProvisioningRepo: StandaloneOrganizationProvisioningRepository,
  ) {}

  async createOrganization(
    user: AuthenticatedRequestUser,
    payload: CreateOrganizationDto,
  ): Promise<{ organization: OrganizationResponseDto; created: boolean }> {
    if (user.source !== 'supabase') {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Standalone organization provisioning requires Supabase auth',
        code: 'STANDALONE_PROVISIONING_ONLY',
      });
    }

    try {
      const result = await this.standaloneProvisioningRepo.provision(
        user.userId,
        payload.name,
      );

      this.logProvisioningResult(user.userId, result);

      return {
        organization: this.toResponse(result.organization),
        created: result.created,
      };
    } catch (error) {
      this.logger.error(
        buildBackendLog(OrganizationsService.name, {
          action: 'standalone-organization-provision',
          outcome: 'failure',
          userId: user.userId,
          ...normalizeError(error),
        }),
      );
      if (error instanceof StandaloneSourceConflictError) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message:
            'Standalone setup is unavailable for an account that already owns another commerce source',
          code: 'STANDALONE_SOURCE_CONFLICT',
        });
      }
      throw error;
    }
  }

  private logProvisioningResult(
    userId: string,
    result: StandaloneOrganizationProvisioningResult,
  ): void {
    this.logger.log(
      buildBackendLog(OrganizationsService.name, {
        action: 'standalone-organization-provision',
        outcome: 'success',
        provisioningResult: result.created ? 'created' : 'existing',
        userId,
        orgId: result.organization.id,
        integrationId: result.integration.id,
        sourceProvisioningResult: result.sourceCreated ? 'created' : 'existing',
      }),
    );
  }

  async updateCurrentOrganization(
    orgId: string,
    payload: UpdateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    const updates: {
      waPhoneNumberId?: string | null;
      waBusinessAccountId?: string | null;
      waAccessToken?: string | null;
    } = {};

    if (payload.wa_phone_number_id !== undefined) {
      updates.waPhoneNumberId = payload.wa_phone_number_id;
    }

    if (payload.wa_business_account_id !== undefined) {
      updates.waBusinessAccountId = payload.wa_business_account_id;
    }

    if (payload.wa_access_token !== undefined) {
      updates.waAccessToken = payload.wa_access_token;
    }

    if (Object.keys(updates).length === 0) {
      const organization = await this.organizationsRepo.findById(orgId);
      if (!organization) {
        throw new NotFoundException('Organization not found');
      }
      return this.toResponse(organization);
    }

    const organization = await this.organizationsRepo.updateById(orgId, {
      ...updates,
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return this.toResponse(organization);
  }

  private toResponse(
    organization: NonNullable<
      Awaited<ReturnType<OrganizationsRepository['findById']>>
    >,
  ): OrganizationResponseDto {
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      plan_type: organization.planType ?? 'free',
      wa_phone_number_id: organization.waPhoneNumberId ?? null,
      wa_business_account_id: organization.waBusinessAccountId ?? null,
      wa_access_token_configured: !!organization.waAccessToken,
    };
  }
}
