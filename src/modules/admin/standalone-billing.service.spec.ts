import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  parseStandaloneCreditBillingConfig,
  STANDALONE_CREDIT_BILLING_CONFIG,
} from '../../shared/config/standalone-credit-billing.config';
import { StandaloneBillingService } from './standalone-billing.service';
import type { StandaloneBillingRepository } from './standalone-billing.repository';

function configuration(approvalEnabled?: string): ConfigService {
  return new ConfigService({
    STANDALONE_CREDIT_APPROVAL_ENABLED: approvalEnabled,
    [STANDALONE_CREDIT_BILLING_CONFIG]: parseStandaloneCreditBillingConfig({}),
  });
}

describe('Standalone credit approval batch orchestration', () => {
  const repository = {
    readPreview: jest.fn(),
    approveOrganization: jest.fn(),
    listOrganizationIds: jest.fn(),
    loadSnapshots: jest.fn(),
    savePreview: jest.fn(),
  };
  const service = (approvalEnabled?: string) =>
    new StandaloneBillingService(
      repository as unknown as StandaloneBillingRepository,
      configuration(approvalEnabled),
    );
  beforeEach(() => jest.resetAllMocks());

  it.each([undefined, 'false', 'TRUE'])(
    'fails closed for configuration %s before reading a preview',
    async (configured) => {
      await expect(
        service(configured).apply('staff', 'preview', 'Approved'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.readPreview).not.toHaveBeenCalled();
    },
  );

  it('uses the authenticated actor, continues after a rolled-back row, and returns all outcomes', async () => {
    repository.readPreview.mockResolvedValue([
      { orgId: 'org-1', fingerprint: 'first' },
      { orgId: 'org-2', fingerprint: 'second' },
    ]);
    repository.approveOrganization
      .mockRejectedValueOnce(new Error('Synthetic database failure'))
      .mockResolvedValueOnce({
        orgId: 'org-2',
        outcome: 'approved',
        reason: 'create_source',
        grantedCredits: 30,
      });

    const result = await service('true').apply('staff', 'preview', 'Approved');

    expect(repository.readPreview).toHaveBeenCalledWith('preview', 'staff');
    expect(repository.approveOrganization).toHaveBeenLastCalledWith(
      { orgId: 'org-2', fingerprint: 'second' },
      'staff',
      'preview',
      'Approved',
      30,
    );
    expect(result.results.map((row) => row.outcome)).toEqual([
      'failed',
      'approved',
    ]);
    expect(result.results[0].reason).toBe('approval_failed');
  });

  it('filters the account listing without hiding the full page counts', async () => {
    repository.listOrganizationIds.mockResolvedValue([
      { id: 'org-1' },
      { id: 'org-2' },
    ]);
    repository.loadSnapshots.mockResolvedValue([
      {
        orgId: 'org-1',
        organization: { id: 'org-1', name: 'Pending' },
        memberships: [{ id: 'm-1', userId: 'owner-1', role: 'owner' }],
        ownedOrganizations: [{ userId: 'owner-1', orgId: 'org-1' }],
        sources: [],
        identityConflict: false,
        claims: [],
        usage: [],
        orderCount: 0,
        account: {
          status: 'pending_approval',
          postedBalance: 0,
          heldCredits: 0,
          version: 0,
          approvedAt: null,
        },
        freeGrantPresent: false,
      },
      {
        orgId: 'org-2',
        organization: { id: 'org-2', name: 'Approved' },
        memberships: [{ id: 'm-2', userId: 'owner-2', role: 'owner' }],
        ownedOrganizations: [{ userId: 'owner-2', orgId: 'org-2' }],
        sources: [],
        identityConflict: false,
        claims: [],
        usage: [],
        orderCount: 0,
        account: {
          status: 'active',
          postedBalance: 30,
          heldCredits: 0,
          version: 1,
          approvedAt: '2026-09-03T00:00:00.000Z',
        },
        freeGrantPresent: true,
      },
    ]);

    const page = await service('true').list(50, undefined, 'eligible');

    expect(page.rows.map((row) => row.orgId)).toEqual(['org-1']);
    expect(page.counts).toMatchObject({ eligible: 1, alreadyApproved: 1 });
    expect(page.approvalEnabled).toBe(true);
  });
});
