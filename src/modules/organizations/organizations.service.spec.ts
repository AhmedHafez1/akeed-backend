import { ForbiddenException } from '@nestjs/common';
import type { OrganizationsRepository } from '../../infrastructure/database/repositories/organizations.repository';
import type { StandaloneOrganizationProvisioningRepository } from '../../infrastructure/database/repositories/standalone-organization-provisioning.repository';
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

function createService(created = true) {
  const organizationsRepo = {
    findById: jest.fn(),
    updateById: jest.fn(),
  };
  const provisioningRepo = {
    provision: jest.fn().mockResolvedValue({ organization, created }),
  };
  const service = new OrganizationsService(
    organizationsRepo as unknown as OrganizationsRepository,
    provisioningRepo as unknown as StandaloneOrganizationProvisioningRepository,
  );

  return { service, provisioningRepo };
}

describe('OrganizationsService standalone provisioning', () => {
  it('provisions an organization for a Supabase identity', async () => {
    const { service, provisioningRepo } = createService(true);

    await expect(
      service.createOrganization(
        { userId: 'user-1', orgId: null, source: 'supabase' },
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
    const { service } = createService(false);

    await expect(
      service.createOrganization(
        { userId: 'user-1', orgId: 'org-1', source: 'supabase' },
        { name: 'Ignored replacement name' },
      ),
    ).resolves.toMatchObject({ created: false });
  });

  it('rejects Shopify identities without calling standalone provisioning', async () => {
    const { service, provisioningRepo } = createService();

    const result = service.createOrganization(
      {
        userId: 'shop-owner',
        orgId: 'shop-org',
        source: 'shopify',
        shop: 'example.myshopify.com',
      },
      { name: 'Example Shop' },
    );

    await expect(result).rejects.toBeInstanceOf(ForbiddenException);
    expect(provisioningRepo.provision).not.toHaveBeenCalled();
  });
});
