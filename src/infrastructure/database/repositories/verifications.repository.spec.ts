import { drizzle } from 'drizzle-orm/pg-proxy';
import { VerificationsRepository } from './verifications.repository';
import * as schema from '../index';

describe('VerificationsRepository follow-up SQL contract', () => {
  afterEach(() => jest.useRealTimers());

  it('replaces message identity, increments attempts and includes terminal-state protection in the executed update', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
    const execute = jest.fn<
      Promise<{ rows: unknown[][] }>,
      [string, unknown[]]
    >(() => Promise.resolve({ rows: [] }));
    const database = drizzle(execute, { schema });
    const repository = new VerificationsRepository(
      database as unknown as ConstructorParameters<
        typeof VerificationsRepository
      >[0],
    );
    await expect(
      repository.markFollowUpSent('ver-1', 'follow-up-wamid'),
    ).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    const [query, params] = execute.mock.calls[0];
    expect(query).toContain('update "verifications" set');
    expect(query).toMatch(/"wa_message_id" = \$\d+/);
    expect(query).toContain(
      'COALESCE("verifications"."follow_up_attempts", 0) + 1',
    );
    expect(query).toMatch(
      /where \("verifications"\."id" = \$\d+ and "verifications"\."status" not in \(\$\d+, \$\d+\)\)/,
    );
    expect(params).toEqual(
      expect.arrayContaining([
        'follow-up-wamid',
        'ver-1',
        'confirmed',
        'canceled',
        '2026-05-15T00:00:00.000Z',
      ]),
    );
    expect(query).not.toMatch(/set[^]*"status"\s*=/);
  });
});
