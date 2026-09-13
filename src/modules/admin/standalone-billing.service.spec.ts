import { ConfigService } from '@nestjs/config';
import {
  parseStandaloneCreditBillingConfig,
  STANDALONE_CREDIT_BILLING_CONFIG,
} from '../../shared/config/standalone-credit-billing.config';
import {
  parseStandaloneBillingOperationsConfig,
  STANDALONE_BILLING_OPERATIONS_CONFIG,
} from '../../shared/config/standalone-billing-operations.config';
import { StandaloneBillingService } from './standalone-billing.service';
import type { StandaloneBillingRepository } from './standalone-billing.repository';

const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

function configuration(): ConfigService {
  return new ConfigService({
    [STANDALONE_CREDIT_BILLING_CONFIG]: parseStandaloneCreditBillingConfig({}),
    [STANDALONE_BILLING_OPERATIONS_CONFIG]:
      parseStandaloneBillingOperationsConfig({
        STANDALONE_BILLING_OPERATIONS_ENABLED: 'true',
        STANDALONE_BILLING_OPERATOR_IDS: OPERATOR,
      }),
  });
}

describe('Standalone billing account listing', () => {
  const repository = {
    listOrganizationIds: jest.fn(),
    loadAccountRows: jest.fn(),
  };
  const service = () =>
    new StandaloneBillingService(
      repository as unknown as StandaloneBillingRepository,
      configuration(),
    );
  beforeEach(() => jest.resetAllMocks());

  it('loads rows for the current page only and returns the next cursor', async () => {
    repository.listOrganizationIds.mockResolvedValue([
      { id: 'org-1' },
      { id: 'org-2' },
      { id: 'org-3' },
    ]);
    const rows = [
      {
        orgId: 'org-1',
        organizationName: 'Active merchant',
        source: null,
        account: {
          status: 'active',
          postedBalance: 30,
          heldCredits: 0,
          availableCredits: 30,
          version: 0,
        },
        freeGrantPresent: true,
        billing: null,
      },
    ];
    repository.loadAccountRows.mockResolvedValue(rows);

    const page = await service().list('staff', { limit: 2 });

    expect(repository.loadAccountRows).toHaveBeenCalledWith(
      ['org-1', 'org-2'],
      10,
    );
    expect(page.rows).toBe(rows);
    expect(page.nextCursor).toBe('org-2');
    expect(page.operations).toEqual({ enabled: true, operator: false });
    expect(page).not.toHaveProperty('counts');
    expect(page).not.toHaveProperty('approvalEnabled');
  });

  it('applies credit filters before paging and reports operator access', async () => {
    repository.listOrganizationIds.mockResolvedValue([]);
    repository.loadAccountRows.mockResolvedValue([]);

    const page = await service().list(OPERATOR, {
      limit: 25,
      cursor: 'org-0',
      accountStatus: 'active',
      balance: 'low',
      reconciliation: 'required',
    });

    expect(repository.listOrganizationIds).toHaveBeenCalledWith(
      25,
      'org-0',
      { accountStatus: 'active', balance: 'low', reconciliation: 'required' },
      10,
    );
    expect(page.nextCursor).toBeNull();
    expect(page.lowBalanceThreshold).toBe(10);
    expect(page.operations).toEqual({ enabled: true, operator: true });
  });
});
