import {
  ManualOrderAcceptanceStateError,
  ManualOrderIngestionRepository,
} from './manual-order-ingestion.repository';

/**
 * Minimal stand-in for the one query `assertPersisted` makes:
 * `select({id}).from(orders).where(...).limit(1)`.
 */
function dbReturning(rows: Array<{ id: string }>) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return {
    select: () => chain,
    transaction: jest.fn(),
  };
}

function acceptance() {
  return {
    eventId: 'event-1',
    order: { id: 'order-1' } as never,
    duplicate: false,
  };
}

describe('ManualOrderIngestionRepository commit verification', () => {
  it('returns the acceptance when the order really is on disk', async () => {
    const db = dbReturning([{ id: 'order-1' }]);
    db.transaction.mockResolvedValue(acceptance());
    const repo = new ManualOrderIngestionRepository(db as never);

    await expect(repo.accept({} as never)).resolves.toMatchObject({
      eventId: 'event-1',
      duplicate: false,
    });
  });

  it('rejects an acceptance whose transaction resolved but did not commit', async () => {
    // The pooler defect this guard exists for: the driver resolves and hands
    // back a real RETURNING id for a transaction Postgres rolled back. Every
    // other signal on the accept path looks healthy, so only a read-back on a
    // fresh connection can tell the difference.
    const db = dbReturning([]);
    db.transaction.mockResolvedValue(acceptance());
    const repo = new ManualOrderIngestionRepository(db as never);

    await expect(repo.accept({} as never)).rejects.toBeInstanceOf(
      ManualOrderAcceptanceStateError,
    );
    await expect(repo.accept({} as never)).rejects.toThrow(
      /was not persisted; the transaction did not commit/,
    );
  });
});
