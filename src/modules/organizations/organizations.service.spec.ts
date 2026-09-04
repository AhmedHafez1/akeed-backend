import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { OrganizationsRepository } from '../../infrastructure/database/repositories/organizations.repository';
import type { StandaloneOrganizationProvisioningRepository } from '../../infrastructure/database/repositories/standalone-organization-provisioning.repository';
import { StandaloneSourceConflictError } from '../../infrastructure/database/repositories/standalone-organization-provisioning.repository';
import { OrganizationsService } from './organizations.service';

const organization = {
  id: 'org-1',
  name: 'Example Company',
  slug: 'standalone-user-1',
  planType: 'free',
  waPhoneNumberId: null,
  waBusinessAccountId: null,
  waAccessToken: null,
  createdAt: null,
  updatedAt: null,
};

const integration = {
  id: 'integration-1',
};

function createService(created = true) {
  const organizationsRepo = {
    findById: jest.fn().mockResolvedValue(organization),
    updateById: jest.fn(),
  };
  const provisioningRepo = {
    provision: jest.fn().mockResolvedValue({
      organization,
      integration,
      created,
      sourceCreated: created,
    }),
  };
  const service = new OrganizationsService(
    organizationsRepo as unknown as OrganizationsRepository,
    provisioningRepo as unknown as StandaloneOrganizationProvisioningRepository,
  );

  return { service, organizationsRepo, provisioningRepo };
}

describe('OrganizationsService standalone provisioning', () => {
  it('provisions an organization for a Supabase identity', async () => {
    const { service, provisioningRepo } = createService(true);

    await expect(
      service.createOrganization(
        { userId: 'user-1', orgId: null, role: null, source: 'supabase' },
        { name: 'Example Company' },
      ),
    ).resolves.toEqual({
      organization: {
        id: 'org-1',
        name: 'Example Company',
        slug: 'standalone-user-1',
        plan_type: 'free',
        wa_phone_number_id: null,
        wa_business_account_id: null,
        wa_access_token_configured: false,
      },
      created: true,
    });
    expect(provisioningRepo.provision).toHaveBeenCalledWith(
      'user-1',
      'Example Company',
    );
  });

  it('returns the existing organization on a retry', async () => {
    const { service, provisioningRepo } = createService(false);

    await expect(
      service.createOrganization(
        { userId: 'user-1', orgId: 'org-1', role: 'owner', source: 'supabase' },
        { name: 'Ignored replacement name' },
      ),
    ).resolves.toMatchObject({ created: false });
    expect(provisioningRepo.provision).not.toHaveBeenCalled();
  });

  it('rejects Shopify identities without calling standalone provisioning', async () => {
    const { service, provisioningRepo } = createService();

    const result = service.createOrganization(
      {
        userId: 'shop-owner',
        orgId: 'shop-org',
        role: 'owner',
        source: 'shopify',
        shop: 'example.myshopify.com',
      },
      { name: 'Example Shop' },
    );

    await expect(result).rejects.toBeInstanceOf(ForbiddenException);
    expect(provisioningRepo.provision).not.toHaveBeenCalled();
  });

  it('does not provision or change an existing member organization', async () => {
    const { service, provisioningRepo } = createService();

    await expect(
      service.createOrganization(
        {
          userId: 'user-1',
          orgId: 'shop-org',
          role: 'viewer',
          source: 'supabase',
        },
        { name: 'Example Company' },
      ),
    ).resolves.toMatchObject({ created: false });
    expect(provisioningRepo.provision).not.toHaveBeenCalled();
  });

  it('keeps the stable conflict for an orgless identity owning another source', async () => {
    const { service, provisioningRepo } = createService();
    provisioningRepo.provision.mockRejectedValue(
      new StandaloneSourceConflictError(),
    );

    const result = service.createOrganization(
      { userId: 'user-1', orgId: null, role: null, source: 'supabase' },
      { name: 'Example Company' },
    );

    await expect(result).rejects.toBeInstanceOf(ConflictException);
  });

  it.each(['owner', 'admin'] as const)(
    'allows a %s to update only the authenticated organization',
    async (role) => {
      const { service, organizationsRepo } = createService();
      organizationsRepo.updateById.mockResolvedValue(organization);

      await service.updateCurrentOrganization(
        { userId: 'user-1', orgId: 'org-1', role, source: 'supabase' },
        { wa_phone_number_id: 'phone-1' },
      );

      expect(organizationsRepo.updateById).toHaveBeenCalledWith('org-1', {
        waPhoneNumberId: 'phone-1',
      });
    },
  );

  it('rejects a viewer before reading or updating organization configuration', async () => {
    const { service, organizationsRepo } = createService();

    await expect(
      service.updateCurrentOrganization(
        {
          userId: 'viewer-1',
          orgId: 'org-1',
          role: 'viewer',
          source: 'supabase',
        },
        { wa_phone_number_id: 'forged' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'ORGANIZATION_ROLE_REQUIRED' },
    });
    expect(organizationsRepo.findById).not.toHaveBeenCalled();
    expect(organizationsRepo.updateById).not.toHaveBeenCalled();
  });
});
