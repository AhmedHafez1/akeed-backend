import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../index';
import { AdminStoreLifecyclesRepository } from './admin-store-lifecycles.repository';

function buildRepository(
  options: { milestoneUpdated?: boolean; isTest?: boolean } = {},
) {
  const statements: { query: string; params: unknown[] }[] = [];
  const execute = jest.fn((query: string, params: unknown[]) => {
    statements.push({ query, params });
    if (query.includes('from "verifications"')) {
      return Promise.resolve({ rows: [['int-1', options.isTest ?? false]] });
    }
    if (query.includes('update "admin_store_lifecycles"')) {
      return Promise.resolve({
        rows: options.milestoneUpdated === false ? [] : [['lifecycle-1']],
      });
    }
    return Promise.resolve({ rows: [] });
  });
  const db = drizzle(execute as never, { schema });
  const productEvents = { insert: jest.fn().mockResolvedValue(undefined) };
  const repository = new AdminStoreLifecyclesRepository(
    db as never,
    productEvents as never,
  );
  return { repository, statements, productEvents };
}

describe('AdminStoreLifecyclesRepository funnel milestones', () => {
  it('records the product event on the first hit of a milestone', async () => {
    const { repository, statements, productEvents } = buildRepository();

    await expect(
      repository.reachMilestone('int-1', 'testSkippedAt', 'test_skipped'),
    ).resolves.toBe(true);

    const update = statements.find(({ query }) =>
      query.includes('update "admin_store_lifecycles"'),
    );
    expect(update?.query).toContain('"test_skipped_at" is null');
    expect(productEvents.insert).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: 'int-1', name: 'test_skipped' }),
    );
  });

  it('does not repeat the event once the milestone is set', async () => {
    const { repository, productEvents } = buildRepository({
      milestoneUpdated: false,
    });

    await expect(
      repository.reachMilestone('int-1', 'testSkippedAt', 'test_skipped'),
    ).resolves.toBe(false);
    expect(productEvents.insert).not.toHaveBeenCalled();
  });

  it('never lets a failed event insert break the caller', async () => {
    const { repository, productEvents } = buildRepository();
    productEvents.insert.mockRejectedValue(new Error('db down'));

    await expect(
      repository.recordEvent('int-1', 'app_installed'),
    ).resolves.toBeUndefined();
  });

  it('marks test_confirmed when the merchant confirms the onboarding test', async () => {
    const { repository, productEvents, statements } = buildRepository({
      isTest: true,
    });

    await repository.recordMessageStatus({
      verificationId: 'verification-1',
      status: 'confirmed',
    });

    expect(
      statements.some(({ query }) => query.includes('"test_confirmed_at"')),
    ).toBe(true);
    expect(productEvents.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test_confirmed' }),
    );
    expect(
      statements.some(({ query }) =>
        query.includes('"first_real_confirmed_at"'),
      ),
    ).toBe(false);
  });

  it('marks the first real confirmation and first reply for a real order', async () => {
    const { repository, productEvents, statements } = buildRepository({
      isTest: false,
    });

    await repository.recordMessageStatus({
      verificationId: 'verification-1',
      status: 'confirmed',
    });

    expect(
      statements.some(({ query }) =>
        query.includes('"first_real_confirmed_at"'),
      ),
    ).toBe(true);
    const names = productEvents.insert.mock.calls.map(
      ([event]: [{ name: string }]) => event.name,
    );
    expect(names).toEqual(['first_order_sent', 'first_reply']);
  });
});
