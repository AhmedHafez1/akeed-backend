import { VerificationsService } from './verifications.service';
import {
  decodeCursor,
  encodeCursor,
} from '../orders/services/pagination.helpers';
import { VERIFICATION_LIST_TABS } from '../../shared/verification/verification-needs-action';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function fixture(withSync = true) {
  const counts = {
    all: 19,
    needs_action: 7,
    confirmed: 5,
    canceled: 3,
    failed: 2,
    no_whatsapp: 1,
  };
  const repo = {
    findByOrg: jest.fn().mockResolvedValue([]),
    countByOrg: jest.fn().mockResolvedValue(4),
    countByTab: jest.fn().mockResolvedValue(counts),
    findHeldByOrg: jest.fn().mockResolvedValue([]),
    countHeldByOrg: jest.fn().mockResolvedValue(3),
    getCustomerHistoryByPhones: jest.fn().mockResolvedValue([]),
  };
  const syncs = { findByCorrelationIds: jest.fn().mockResolvedValue([]) };
  const autoCancellations = {
    findByVerificationIds: jest.fn().mockResolvedValue([]),
  };
  const service = new VerificationsService(
    repo as never,
    {} as never,
    { findByOrg: jest.fn().mockResolvedValue([]) } as never,
    {} as never,
    { supports: () => false } as never,
    {} as never,
    withSync ? (syncs as never) : undefined,
    autoCancellations as never,
  );
  return { service, repo, syncs, counts, autoCancellations };
}

function verification(id: string) {
  return {
    id,
    orderId: `order-${id}`,
    status: 'confirmed',
    createdAt: '2026-10-20T12:00:00.000Z',
    order: {
      orgId: 'org-a',
      customerPhone: '+201000000001',
      externalOrderId: `external-${id}`,
      isTest: false,
    },
  };
}

describe('Verification list read efficiency', () => {
  it.each(['no_reply', 'delivered'])(
    'reports auto-cancel toggle capability for %s',
    async (status) => {
      const { service, repo, autoCancellations } = fixture();
      repo.findByOrg.mockResolvedValue([{ ...verification('v1'), status }]);
      autoCancellations.findByVerificationIds.mockResolvedValue([
        {
          verificationId: 'v1',
          status: 'paused',
          dueAt: null,
          reason: 'reminder_not_delivered',
          lateReplyAt: null,
        },
      ]);
      const response = await service.listByOrg('org-a', {});
      expect(response.data[0].capabilities).toContainEqual({
        action: 'auto_cancel_exclusion',
        supported: status !== 'no_reply',
      });
      expect(response.data[0].auto_cancel?.state).toBe('paused');
    },
  );

  it.each(VERIFICATION_LIST_TABS)(
    'reuses the aggregate for tab %s',
    async (tab) => {
      const { service, repo, counts } = fixture();
      const response = await service.listByOrg('org-a', { tab });
      expect(response.total_count).toBe(counts[tab] + (tab === 'all' ? 3 : 0));
      expect(repo.countByOrg).not.toHaveBeenCalled();
      expect(repo.countByTab).toHaveBeenCalledTimes(1);
      expect(repo.countByTab).toHaveBeenCalledWith(
        'org-a',
        expect.anything(),
        undefined,
      );
    },
  );

  it.each([
    { q: '#12 (34)', digits: '1234' },
    { q: '+20 100', digits: '20100' },
  ])('retains the filtered count for $q', async ({ q, digits }) => {
    const { service, repo } = fixture();
    const response = await service.listByOrg('org-a', { q, tab: 'confirmed' });
    expect(response.total_count).toBe(4);
    expect(repo.countByOrg).toHaveBeenCalledWith(
      'org-a',
      undefined,
      expect.anything(),
      undefined,
      expect.objectContaining({ tab: 'confirmed', searchDigits: digits }),
    );
  });

  it('reuses counts for a search that normalizes to no digits', async () => {
    const { service, repo } = fixture();
    await service.listByOrg('org-a', { q: ' ()- ' });
    expect(repo.countByOrg).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'failed,no_reply', 'confirmed,awaiting_start'])(
    'retains the filtered count for explicit statuses %s',
    async (status) => {
      const { service, repo } = fixture();
      const response = await service.listByOrg('org-a', { status });
      expect(repo.countByOrg).toHaveBeenCalledTimes(1);
      expect(response.total_count).toBe(
        status.includes('awaiting_start') ? 7 : 4,
      );
    },
  );

  it('skips verification reads and their count for held-only requests', async () => {
    const { service, repo } = fixture();
    const response = await service.listByOrg('org-a', {
      status: 'awaiting_start',
    });
    expect(response.total_count).toBe(3);
    expect(repo.findByOrg).not.toHaveBeenCalled();
    expect(repo.countByOrg).not.toHaveBeenCalled();
  });

  it('keeps aggregate totals independent of the page cursor and scoped to the batch', async () => {
    const { service, repo } = fixture();
    const cursor = { id: 'v2', createdAt: '2026-10-20T12:00:00.000Z' };
    const response = await service.listByOrg('org-b', {
      cursor: encodeCursor(cursor),
      importBatchId: 'batch-b',
    });
    expect(response.total_count).toBe(22);
    expect(repo.findByOrg).toHaveBeenCalledWith(
      'org-b',
      undefined,
      expect.anything(),
      expect.objectContaining({ cursor, importBatchId: 'batch-b' }),
    );
    expect(repo.countByTab).toHaveBeenCalledWith(
      'org-b',
      expect.anything(),
      'batch-b',
    );
    expect(repo.countHeldByOrg).toHaveBeenCalledWith(
      'org-b',
      expect.anything(),
      'batch-b',
    );
  });

  it('returns zeros and no cursor for an empty organization', async () => {
    const { service, repo, counts } = fixture();
    repo.countByTab.mockResolvedValue(
      Object.fromEntries(Object.keys(counts).map((key) => [key, 0])),
    );
    repo.countHeldByOrg.mockResolvedValue(0);
    const response = await service.listByOrg('empty-org', {});
    expect(response).toMatchObject({
      data: [],
      total_count: 0,
      next_cursor: null,
    });
  });

  it('preserves id ordering and cursor identity when both streams share timestamps', async () => {
    const { service, repo } = fixture();
    repo.findByOrg.mockResolvedValue([verification('v3'), verification('v1')]);
    repo.findHeldByOrg.mockResolvedValue([
      { ...verification('v2'), orderId: 'v2', stage: 'awaiting_start' },
    ]);
    const response = await service.listByOrg('org-a', { limit: 2 });
    expect(response.data.map((row) => row.id)).toEqual(['v3', 'v2']);
    expect(decodeCursor(response.next_cursor ?? undefined)).toEqual({
      id: 'v2',
      createdAt: '2026-10-20T12:00:00.000Z',
    });
  });

  it('starts both enrichment reads before either settles', async () => {
    const { service, repo, syncs } = fixture();
    const history = deferred<[]>();
    const synchronization = deferred<[]>();
    repo.findByOrg.mockResolvedValue([verification('v1')]);
    repo.getCustomerHistoryByPhones.mockReturnValue(history.promise);
    syncs.findByCorrelationIds.mockReturnValue(synchronization.promise);
    const response = service.listByOrg('org-a', {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(syncs.findByCorrelationIds).toHaveBeenCalledWith('org-a', ['v1']);
    expect(repo.getCustomerHistoryByPhones).toHaveBeenCalledWith('org-a', [
      '+201000000001',
    ]);
    history.resolve([]);
    synchronization.resolve([]);
    expect((await response).data).toHaveLength(1);
  });

  it.each(['sync', 'history'])(
    'propagates a failed %s read',
    async (failed) => {
      const { service, repo, syncs } = fixture();
      const error = new Error('read unavailable');
      if (failed === 'sync')
        syncs.findByCorrelationIds.mockRejectedValue(error);
      else repo.getCustomerHistoryByPhones.mockRejectedValue(error);
      await expect(service.listByOrg('org-a', {})).rejects.toBe(error);
    },
  );

  it('keeps synchronization optional', async () => {
    const { service, repo } = fixture(false);
    repo.findByOrg.mockResolvedValue([verification('v1')]);
    expect(
      (await service.listByOrg('org-a', {})).data[0].remote_sync,
    ).toBeNull();
  });
});
