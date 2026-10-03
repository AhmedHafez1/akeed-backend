import { ConflictException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { OrganizationsRepository } from '../../infrastructure/database/repositories/organizations.repository';
import type { StandaloneOrganizationProvisioningRepository } from '../../infrastructure/database/repositories/standalone-organization-provisioning.repository';
import { EASYORDERS_CONFIG } from '../../shared/config/easyorders.config';
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

const orgless = {
  userId: 'user-1',
  orgId: null,
  role: null,
  source: 'supabase' as const,
};

function createService(options: { connectEnabled: boolean; config?: boolean }) {
  const organizationsRepo = {
    findById: jest.fn().mockResolvedValue(organization),
  };
  const provisioningRepo = {
    provision: jest.fn().mockResolvedValue({
      organization,
      integration: { id: 'integration-1' },
      created: true,
      sourceCreated: true,
    }),
    provisionWithoutSource: jest
      .fn()
      .mockResolvedValue({ organization, created: true }),
  };
  const config = {
    get: (key: string) =>
      key === EASYORDERS_CONFIG
        ? { enabled: options.connectEnabled }
        : undefined,
  };
  const service = new OrganizationsService(
    organizationsRepo as unknown as OrganizationsRepository,
    provisioningRepo as unknown as StandaloneOrganizationProvisioningRepository,
    options.config === false ? undefined : (config as unknown as ConfigService),
  );
  return { service, provisioningRepo };
}

describe('OrganizationsService source-choosing signup', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates the organization without a Standalone source when signup chose to connect a platform', async () => {
    const { service, provisioningRepo } = createService({
      connectEnabled: true,
    });

    await expect(
      service.createOrganization(orgless, {
        name: 'Example Company',
        sourceMode: 'connect',
      }),
    ).resolves.toMatchObject({ organization: { id: 'org-1' }, created: true });

    expect(provisioningRepo.provisionWithoutSource).toHaveBeenCalledWith(
      'user-1',
      'Example Company',
    );
    expect(provisioningRepo.provision).not.toHaveBeenCalled();
  });

  it.each([
    ['no connectable platform is switched on', { connectEnabled: false }],
    ['configuration is absent', { connectEnabled: true, config: false }],
  ])(
    'refuses to leave an organization without a source when %s',
    async (_label, options) => {
      const { service, provisioningRepo } = createService(options);

      const result = service.createOrganization(orgless, {
        name: 'Example Company',
        sourceMode: 'connect',
      });

      await expect(result).rejects.toBeInstanceOf(ConflictException);
      await expect(result).rejects.toMatchObject({
        response: { code: 'SOURCE_CONNECT_UNAVAILABLE' },
      });
      expect(provisioningRepo.provisionWithoutSource).not.toHaveBeenCalled();
      expect(provisioningRepo.provision).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'standalone'] as const)(
    'still provisions the Standalone source when sourceMode is %s',
    async (sourceMode) => {
      const { service, provisioningRepo } = createService({
        connectEnabled: true,
      });

      await service.createOrganization(orgless, {
        name: 'Example Company',
        sourceMode,
      });

      expect(provisioningRepo.provision).toHaveBeenCalledWith(
        'user-1',
        'Example Company',
      );
      expect(provisioningRepo.provisionWithoutSource).not.toHaveBeenCalled();
    },
  );

  it('never provisions a second time for a member, so a source-less organization is not converted to Standalone', async () => {
    const { service, provisioningRepo } = createService({
      connectEnabled: true,
    });

    await expect(
      service.createOrganization(
        { userId: 'user-1', orgId: 'org-1', role: 'owner', source: 'supabase' },
        { name: 'Example Company' },
      ),
    ).resolves.toMatchObject({ created: false });

    expect(provisioningRepo.provision).not.toHaveBeenCalled();
    expect(provisioningRepo.provisionWithoutSource).not.toHaveBeenCalled();
  });
});
