import {
  ACCEPTANCE_CHUNK,
  ManualOrderAcceptanceStateError,
  ManualOrderIngestionRepository,
  type AcceptanceRowResult,
} from './manual-order-ingestion.repository';

/**
 * Minimal stand-in for the one query `assertPersisted` makes:
 * `select({id}).from(orders).where(inArray(...))`.
 */
function dbReturning(rows: Array<{ id: string }>) {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  return {
    select: () => chain,
    transaction: jest.fn(),
  };
}

function acceptance(id = 'order-1'): AcceptanceRowResult {
  return {
    status: 'accepted',
    eventId: `event-${id}`,
    order: { id } as never,
    duplicate: false,
  };
}

describe('ManualOrderIngestionRepository commit verification', () => {
  it('returns the acceptance when the order really is on disk', async () => {
    const db = dbReturning([{ id: 'order-1' }]);
    db.transaction.mockResolvedValue(acceptance());
    const repo = new ManualOrderIngestionRepository(db as never);

    await expect(repo.accept({} as never)).resolves.toMatchObject({
      eventId: 'event-order-1',
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

  it('still throws on the manual path when the identity is already taken', async () => {
    // Held rows report this per row; a manual key collision on a *generated*
    // identity is a bug, so `accept()` must keep failing loudly.
    const db = dbReturning([{ id: 'order-1' }]);
    db.transaction.mockResolvedValue({ status: 'already_imported' });
    const repo = new ManualOrderIngestionRepository(db as never);

    await expect(repo.accept({} as never)).rejects.toThrow(
      /generated manual order identity already exists/,
    );
  });

  it('names the first order the read-back could not find', async () => {
    const db = dbReturning([{ id: 'order-a' }, { id: 'order-c' }]);
    db.transaction.mockResolvedValue([
      acceptance('order-a'),
      acceptance('order-b'),
      acceptance('order-c'),
    ]);
    const repo = new ManualOrderIngestionRepository(db as never);

    await expect(
      repo.acceptMany([{}, {}, {}] as never, { hold: { groupId: 'batch-1' } }),
    ).rejects.toThrow(/order-b was not persisted/);
  });

  it('reads back only the rows that were accepted', async () => {
    // A row that lost the reference race has no order to verify, so it must
    // not be handed to the read-back as an id that will never be found.
    const db = dbReturning([{ id: 'order-a' }]);
    db.transaction.mockResolvedValue([
      acceptance('order-a'),
      { status: 'already_imported' },
    ]);
    const repo = new ManualOrderIngestionRepository(db as never);

    await expect(
      repo.acceptMany([{}, {}] as never, { hold: { groupId: 'batch-1' } }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'accepted' }),
      { status: 'already_imported' },
    ]);
  });

  it('opens one transaction per chunk and preserves input order', async () => {
    const inputs = Array.from({ length: ACCEPTANCE_CHUNK + 5 }, () => ({}));
    const db = dbReturning(
      inputs.map((_, index) => ({ id: `order-${index}` })),
    );
    let offset = 0;
    db.transaction.mockImplementation(() => {
      const size = Math.min(ACCEPTANCE_CHUNK, inputs.length - offset);
      const chunk = Array.from({ length: size }, (_, index) =>
        acceptance(`order-${offset + index}`),
      );
      offset += size;
      return Promise.resolve(chunk);
    });
    const repo = new ManualOrderIngestionRepository(db as never);

    const results = await repo.acceptMany(inputs as never, {
      hold: { groupId: 'batch-1' },
    });

    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(ACCEPTANCE_CHUNK + 5);
    expect(
      results.map((result) => (result as never as { eventId: string }).eventId),
    ).toEqual(inputs.map((_, index) => `event-order-${index}`));
  });

  it('accepts nothing without touching the database', async () => {
    const db = dbReturning([]);
    const repo = new ManualOrderIngestionRepository(db as never);

    await expect(
      repo.acceptMany([], { hold: { groupId: 'batch-1' } }),
    ).resolves.toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
