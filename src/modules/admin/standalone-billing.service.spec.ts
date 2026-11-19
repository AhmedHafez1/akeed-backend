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

describe('Standalone billing checkout attempts', () => {
  const repository = { listCheckoutAttempts: jest.fn() };
  const service = () =>
    new StandaloneBillingService(
      repository as unknown as StandaloneBillingRepository,
      configuration(),
    );
  const NOW = Date.parse('2026-11-19T21:00:00Z');
  const row = (orgId: string, overrides: Record<string, unknown> = {}) => ({
    org_id: orgId,
    organization_name: 'Merchant',
    attempts: 2,
    first_attempt_at: new Date('2026-11-18T04:25:44Z'),
    last_attempt_at: '2026-11-18 04:26:11.91+00',
    paid_ever: false,
    reference: `ref-${orgId}`,
    status: 'pending',
    total_minor: 20000,
    currency: 'EGP',
    checkout_expires_at: new Date('2026-11-18T04:41:12Z'),
    reconciliation_code: null,
    decline_code: null,
    owner_email: 'owner@merchant.test',
    owner_name: 'Owner',
    platform_type: 'standalone',
    platform_store_url: 'standalone://merchant',
    merchant_whatsapp_phone: '+201000000000',
    ...overrides,
  });
  beforeEach(() => jest.resetAllMocks());

  it('pages with one extra row and maps contact details and outcomes', async () => {
    repository.listCheckoutAttempts.mockResolvedValue([
      row('org-1'),
      row('org-2', {
        status: 'failed',
        decline_code: 'authentication_failed',
        paid_ever: true,
        platform_type: null,
        platform_store_url: null,
      }),
      row('org-3'),
    ]);
    const page = await service().checkoutAttempts(
      { limit: 2, offset: 10, paid: 'all' },
      NOW,
    );
    expect(repository.listCheckoutAttempts).toHaveBeenCalledWith(
      2,
      10,
      'all',
      'live',
    );
    expect(page.nextOffset).toBe(12);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toEqual({
      orgId: 'org-1',
      organizationName: 'Merchant',
      owner: {
        name: 'Owner',
        email: 'owner@merchant.test',
        whatsappPhone: '+201000000000',
      },
      source: { platformType: 'standalone', identity: 'standalone://merchant' },
      attempts: 2,
      firstAttemptAt: '2026-11-18T04:25:44.000Z',
      lastAttemptAt: '2026-11-18T04:26:11.910Z',
      paidEver: false,
      latest: {
        reference: 'ref-org-1',
        status: 'pending',
        outcome: 'left_checkout',
        declineCode: null,
        reconciliationCode: null,
        totalMinor: 20000,
        currency: 'EGP',
      },
    });
    expect(page.rows[1].latest.outcome).toBe('declined');
    expect(page.rows[1].source).toBeNull();
  });

  it('defaults to the first page of every merchant and reports no next page', async () => {
    repository.listCheckoutAttempts.mockResolvedValue([row('org-1')]);
    const page = await service().checkoutAttempts({}, NOW);
    expect(repository.listCheckoutAttempts).toHaveBeenCalledWith(
      50,
      0,
      'all',
      'live',
    );
    expect(page.nextOffset).toBeNull();
  });
});
