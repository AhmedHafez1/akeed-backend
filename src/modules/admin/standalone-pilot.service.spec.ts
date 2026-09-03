import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { StandalonePilotService } from './standalone-pilot.service';
import type { StandalonePilotRepository } from './standalone-pilot.repository';

describe('Standalone pilot batch orchestration', () => {
  const repository = {
    readPreview: jest.fn(),
    applyOrganization: jest.fn(),
    listOrganizationIds: jest.fn(),
    loadSnapshots: jest.fn(),
    savePreview: jest.fn(),
  };
  beforeEach(() => jest.resetAllMocks());
  it.each([undefined, 'false', 'TRUE'])(
    'fails closed for configuration %s before reading a preview',
    async (configured) => {
      const service = new StandalonePilotService(
        repository as unknown as StandalonePilotRepository,
        new ConfigService({ STANDALONE_PILOT_ACTIVATION_ENABLED: configured }),
      );
      await expect(
        service.apply('staff', 'preview', 'Approved pilot'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.readPreview).not.toHaveBeenCalled();
    },
  );
  it('uses the authenticated actor, continues after a rolled-back row, and returns all outcomes', async () => {
    repository.readPreview.mockResolvedValue([
      { orgId: 'org-1', fingerprint: 'first' },
      { orgId: 'org-2', fingerprint: 'second' },
    ]);
    repository.applyOrganization
      .mockRejectedValueOnce(new Error('Synthetic database failure'))
      .mockResolvedValueOnce({
        orgId: 'org-2',
        outcome: 'activated',
        reason: 'create_source',
      });
    const service = new StandalonePilotService(
      repository as unknown as StandalonePilotRepository,
      new ConfigService({ STANDALONE_PILOT_ACTIVATION_ENABLED: 'true' }),
    );
    const result = await service.apply('staff', 'preview', 'Approved pilot');
    expect(repository.readPreview).toHaveBeenCalledWith('preview', 'staff');
    expect(repository.applyOrganization).toHaveBeenLastCalledWith(
      { orgId: 'org-2', fingerprint: 'second' },
      'staff',
      'preview',
      'Approved pilot',
    );
    expect(result.results.map((row) => row.outcome)).toEqual([
      'failed',
      'activated',
    ]);
  });
});
