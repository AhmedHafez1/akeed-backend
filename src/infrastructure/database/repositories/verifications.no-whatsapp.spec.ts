import { drizzle } from 'drizzle-orm/pg-proxy';
import { VerificationsRepository } from './verifications.repository';
import * as schema from '../index';

function buildRepository() {
  const execute = jest.fn<Promise<{ rows: unknown[][] }>, [string, unknown[]]>(
    () => Promise.resolve({ rows: [] }),
  );
  const repository = new VerificationsRepository(
    drizzle(execute, { schema }) as never,
  );
  return { repository, execute };
}

function setClause(query: string): string {
  return query.split(' where ')[0];
}

describe('VerificationsRepository: number not on WhatsApp', () => {
  it('moves an undelivered row to no_whatsapp with its code and first time', async () => {
    const { repository, execute } = buildRepository();

    await repository.updateStatusByWamid('wamid-1', 'failed', '1700000000', {
      code: 131026,
      title: 'Message undeliverable',
    });

    const [query, params] = execute.mock.calls[0];
    const set = setClause(query);
    expect(set).toContain(
      `"status" = CASE WHEN ("verifications"."delivered_at" IS NULL AND "verifications"."read_at" IS NULL) THEN 'no_whatsapp'::verification_status ELSE "verifications"."status" END`,
    );
    expect(set).toContain('COALESCE("verifications"."no_whatsapp_at",');
    expect(set).toContain('"delivery_error_code" = CASE');
    // The stale failure reason is dropped so the row never reads as retryable.
    expect(set).toContain(`- 'reason' - 'kind'`);
    expect(params).toEqual(
      expect.arrayContaining([
        '2023-11-14T22:13:20.000Z',
        '131026',
        JSON.stringify({
          providerErrorCode: '131026',
          providerErrorTitle: 'Message undeliverable',
        }),
        // A duplicate or late receipt cannot touch a no_whatsapp row.
        'no_whatsapp',
      ]),
    );
  });

  it('keeps the generic failure for any other code', async () => {
    const { repository, execute } = buildRepository();

    await repository.updateStatusByWamid('wamid-1', 'failed', '1700000000', {
      code: 131049,
    });

    const [query, params] = execute.mock.calls[0];
    expect(setClause(query)).not.toContain('no_whatsapp');
    expect(params).toEqual(
      expect.arrayContaining([
        'failed',
        expect.stringContaining('provider_delivery_failed'),
      ]),
    );
  });

  it('protects no_whatsapp from automation and receipts', async () => {
    const { repository, execute } = buildRepository();

    await repository.updateStatus('ver-1', 'no_reply');

    const [, params] = execute.mock.calls[0];
    expect(params).toEqual(
      expect.arrayContaining([
        'confirmed',
        'canceled',
        'no_reply',
        'no_whatsapp',
      ]),
    );
  });

  it('lets a customer reply override no_whatsapp', async () => {
    const { repository, execute } = buildRepository();

    await repository.updateStatus(
      'ver-1',
      'confirmed',
      undefined,
      '1700000000',
    );

    const [query, params] = execute.mock.calls[0];
    expect(query).toMatch(/"status" not in \(\$\d+, \$\d+\)\) returning/);
    expect(params).not.toContain('no_whatsapp');
  });

  it('removes a metadata key in-database', async () => {
    const { repository, execute } = buildRepository();

    await repository.removeMetadataKeys('ver-1', ['follow_up_due_at']);

    const [query, params] = execute.mock.calls[0];
    expect(query).toContain(
      `COALESCE("verifications"."metadata", '{}'::jsonb) - ARRAY[$1]::text[]`,
    );
    expect(params).toEqual(
      expect.arrayContaining(['follow_up_due_at', 'ver-1']),
    );
  });

  it('filters the no_whatsapp tab on the status', async () => {
    const { repository, execute } = buildRepository();

    await repository.findByOrg('org-1', undefined, undefined, {
      tab: 'no_whatsapp',
    });

    const [query, params] = execute.mock.calls[0];
    expect(query).toMatch(/"verifications"\."status" = \$\d+/);
    expect(params).toContain('no_whatsapp');
  });
});
