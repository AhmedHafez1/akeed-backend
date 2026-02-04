import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CreateOrganizationDto,
  OrganizationResponseDto,
  UpdateOrganizationDto,
} from '../dto/organizations.dto';
import { OrganizationsRepository } from '../../infrastructure/database/repositories/organizations.repository';
import { MembershipsRepository } from '../../infrastructure/database/repositories/memberships.repository';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly organizationsRepo: OrganizationsRepository,
    private readonly membershipsRepo: MembershipsRepository,
  ) {}

  async createOrganization(
    userId: string,
    payload: CreateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    const organization = await this.organizationsRepo.createOrUpdateBySlug(
      payload.name,
      payload.slug,
    );

    await this.membershipsRepo.createOrUpdateMembership(
      organization.id,
      userId,
      'owner',
    );

    return this.toResponse(organization);
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
      wa_access_token: organization.waAccessToken ?? null,
    };
  }
}
