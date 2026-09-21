import type { Job } from 'bullmq';
import { OrderImportCommitProcessor } from './order-import-commit.processor';
import type { OrderImportCommitJob } from './order-import-queue.constants';

const BATCH = 'batch-1';
const ORG = 'org-1';

function batchRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH,
    status: 'committing',
    expiresAt: '2026-09-20T09:00:00.000Z',
    integrationId: 'int-1',
    shortCode: 'ABC123',
    platformStoreUrl: 'store-1.akeed.local',
    mapping: { confirmed: true },
    counts: { ready: 0 },
    commitIdempotencyKey: `commit-${BATCH}`,
    ...overrides,
  };
}

function row(rowNumber: number) {
  return {
    rowNumber,
    normalized: {
      orderNumber: `#${1000 + rowNumber}`,
      customerPhone: '+201012345678',
      customerName: 'Ahmed Ali',
      totalPrice: '750.00',
      currency: 'EGP',
      paymentMethod: 'cash_on_delivery',
    },
    dedupeKey: `ref:${1000 + rowNumber}`,
  };
}

function job(): Job<OrderImportCommitJob> {
  return {
    data: { batchId: BATCH, orgId: ORG },
    opts: { attempts: 5 },
    attemptsMade: 0,
  } as unknown as Job<OrderImportCommitJob>;
}

function setup() {
  const repository = {
    findBatchForCommit: jest.fn().mockResolvedValue(batchRecord()),
    listRowsForCommit: jest.fn().mockResolvedValue([]),
    writeCommitChunk: jest.fn().mockResolvedValue(undefined),
    finishCommit: jest.fn().mockResolvedValue(undefined),
    failCommit: jest.fn().mockResolvedValue(undefined),
  };
  const ingestion = { acceptMany: jest.fn() };
  const config = {
    get: () => ({ enabled: true, startWindowHours: 72 }),
  };
  const processor = new OrderImportCommitProcessor(
    repository as never,
    ingestion as never,
    config as never,
  );
  return { processor, repository, ingestion };
}

/** `listRowsForCommit` answers each page in turn, then runs dry. */
function pages(
  repository: { listRowsForCommit: jest.Mock },
  ...batches: unknown[][]
) {
  for (const page of batches)
    repository.listRowsForCommit.mockResolvedValueOnce(page);
  repository.listRowsForCommit.mockResolvedValue([]);
}

describe('OrderImportCommitProcessor', () => {
  it('creates every ready row and closes the batch as awaiting start', async () => {
    const { processor, repository, ingestion } = setup();
    pages(repository, [row(1), row(2)]);
    ingestion.acceptMany.mockResolvedValue([
      {
        status: 'accepted',
        orderId: 'order-1',
        eventId: 'event-1',
        duplicate: false,
      },
      {
        status: 'accepted',
        orderId: 'order-2',
        eventId: 'event-2',
        duplicate: false,
      },
    ]);

    await processor.process(job());

    expect(ingestion.acceptMany).toHaveBeenCalledWith(
      {
        orgId: ORG,
        source: { id: 'int-1', platformStoreUrl: 'store-1.akeed.local' },
      },
      expect.arrayContaining([
        expect.objectContaining({ idempotencyKey: `${BATCH}:1` }),
      ]),
      { channel: 'bulk_import', hold: { groupId: BATCH } },
    );
    expect(repository.writeCommitChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        imported: [
          { rowNumber: 1, orderId: 'order-1', eventId: 'event-1' },
          { rowNumber: 2, orderId: 'order-2', eventId: 'event-2' },
        ],
        alreadyImported: [],
      }),
    );
    expect(repository.finishCommit).toHaveBeenCalledWith(
      expect.objectContaining({ startWindowHours: 72 }),
    );
  });

  it('marks the row that lost a reference race as already imported', async () => {
    const { processor, repository, ingestion } = setup();
    pages(repository, [row(1), row(2)]);
    ingestion.acceptMany.mockResolvedValue([
      {
        status: 'accepted',
        orderId: 'order-1',
        eventId: 'event-1',
        duplicate: false,
      },
      { status: 'already_imported' },
    ]);

    await processor.process(job());

    expect(repository.writeCommitChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        imported: [{ rowNumber: 1, orderId: 'order-1', eventId: 'event-1' }],
        alreadyImported: [2],
      }),
    );
  });

  it('walks the batch in row order, a chunk at a time', async () => {
    const { processor, repository, ingestion } = setup();
    pages(repository, [row(1), row(2)], [row(3)]);
    ingestion.acceptMany
      .mockResolvedValueOnce([
        { status: 'accepted', orderId: 'o1', eventId: 'e1', duplicate: false },
        { status: 'accepted', orderId: 'o2', eventId: 'e2', duplicate: false },
      ])
      .mockResolvedValueOnce([
        { status: 'accepted', orderId: 'o3', eventId: 'e3', duplicate: false },
      ]);

    await processor.process(job());

    // Each page resumes after the last row number it saw, which is also what
    // makes a crashed run continue instead of repeating.
    expect(
      (
        repository.listRowsForCommit.mock.calls as Array<
          [{ afterRowNumber: number }]
        >
      ).map(([args]) => args.afterRowNumber),
    ).toEqual([0, 2, 3]);
    expect(repository.writeCommitChunk).toHaveBeenCalledTimes(2);
    expect(repository.finishCommit).toHaveBeenCalledTimes(1);
  });

  it('creates nothing on a re-run once every row is linked', async () => {
    // The crash-resume case: `listRowsForCommit` filters out rows that already
    // have an order id, so a second pass has nothing to do but finish.
    const { processor, repository, ingestion } = setup();
    pages(repository);

    await processor.process(job());

    expect(ingestion.acceptMany).not.toHaveBeenCalled();
    expect(repository.writeCommitChunk).not.toHaveBeenCalled();
    expect(repository.finishCommit).toHaveBeenCalledTimes(1);
  });

  it.each(['awaiting_start', 'failed', 'stopped'])(
    'does not re-open a batch that already left committing (%s)',
    async (status) => {
      const { processor, repository, ingestion } = setup();
      repository.findBatchForCommit.mockResolvedValue(batchRecord({ status }));

      await processor.process(job());

      expect(ingestion.acceptMany).not.toHaveBeenCalled();
      expect(repository.finishCommit).not.toHaveBeenCalled();
    },
  );

  it('leaves the batch committing while BullMQ still has attempts left', async () => {
    const { processor, repository } = setup();
    const failing = { ...job(), attemptsMade: 2 } as Job<OrderImportCommitJob>;

    await processor.onFailed(failing, new Error('database unavailable'));

    expect(repository.failCommit).not.toHaveBeenCalled();
  });

  it('fails the batch once the attempts are exhausted', async () => {
    const { processor, repository } = setup();
    const failing = { ...job(), attemptsMade: 5 } as Job<OrderImportCommitJob>;

    await processor.onFailed(failing, new Error('database unavailable'));

    expect(repository.failCommit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, batchId: BATCH }),
    );
  });
});
