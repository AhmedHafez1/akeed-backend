import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../index';
import { OrdersRepository } from './orders.repository';

describe('OrdersRepository activation confirmation lookup', () => {
  function setup(rows: unknown[][] = []) {
    const execute = jest.fn<
      Promise<{ rows: unknown[][] }>,
      [string, unknown[]]
    >(() => Promise.resolve({ rows }));
    const repository = new OrdersRepository(
      drizzle(execute, { schema }) as never,
    );
    return { repository, execute };
  }

  it('returns the first confirmation timestamp with a bounded, tenant-scoped query', async () => {
    const confirmedAt = '2026-11-12T08:00:00.000Z';
    const { repository, execute } = setup([[confirmedAt]]);

    await expect(
      repository.findFirstCustomerConfirmationAt('org-1', 'integration-1'),
    ).resolves.toBe(confirmedAt);

    const [query, params] = execute.mock.calls[0];
    expect(query).toContain('"orders"."org_id" = "verifications"."org_id"');
    expect(query).toMatch(/"verifications"\."org_id" = \$\d+/);
    expect(query).toMatch(/"orders"\."integration_id" = \$\d+/);
    expect(query).toMatch(/"orders"\."is_test" = \$\d+/);
    expect(query).toContain("NOT LIKE 'akeed-test-%'");
    expect(query).toContain("IS DISTINCT FROM 'merchant_manual'");
    expect(query).toContain('"verifications"."confirmed_at" is not null');
    expect(query).toContain(
      'order by "verifications"."confirmed_at" asc limit',
    );
    expect(params).toEqual(['org-1', 'integration-1', false, 1]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('leaves activation incomplete when no qualifying confirmation exists', async () => {
    const { repository } = setup();
    await expect(
      repository.findFirstCustomerConfirmationAt('org-1', 'integration-1'),
    ).resolves.toBeNull();
  });
});
