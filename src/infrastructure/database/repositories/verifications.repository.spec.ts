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

describe('VerificationsRepository search SQL contract', () => {
  it('matches order-number digits anywhere in both list and count queries', async () => {
    const execute = jest.fn<
      Promise<{ rows: unknown[][] }>,
      [string, unknown[]]
    >(() => Promise.resolve({ rows: [] }));
    const repository = new VerificationsRepository(
      drizzle(execute, { schema }) as never,
    );

    await repository.findByOrg('org-1', undefined, undefined, {
      searchDigits: '2074',
    });
    await repository.countByOrg('org-1', undefined, undefined, undefined, {
      searchDigits: '2074',
    });

    expect(execute).toHaveBeenCalledTimes(2);
    for (const [query, params] of execute.mock.calls) {
      expect(query).toContain("regexp_replace(o.order_number, '\\D', '', 'g')");
      expect(query).toMatch(/regexp_replace\(o\.order_number,[^]*LIKE \$\d+/);
      expect(params).toEqual(expect.arrayContaining(['%2074%']));
      expect(params).toContain('org-1');
    }
  });
});

describe('Merchant cancellation persistence', () => {
  it('merges the provider reference atomically with the guarded local transition without replacing metadata', async () => {
    const execute = jest.fn<
      Promise<{ rows: unknown[][] }>,
      [string, unknown[]]
    >(() => Promise.resolve({ rows: [] }));
    const repository = new VerificationsRepository(
      drizzle(execute, { schema }) as never,
    );
    await repository.markMerchantNoReplyCanceled(
      'ver-1',
      'org-1',
      '2026-09-02T00:00:00Z',
      {
        status: 'pending_provider_operation',
        providerOperationId: 'operation-1',
      },
    );
    const [query, params] = execute.mock.calls[0];
    expect(query).toContain('COALESCE("verifications"."metadata",');
    expect(query).toContain('||');
    expect(query).toMatch(/CASE[^]*END in \(\$\d+, \$\d+, \$\d+, \$\d+\)/);
    expect(params).toEqual(
      expect.arrayContaining([
        'no_whatsapp',
        'no_reply_after_follow_up',
        'read_no_reply',
        'no_reply',
      ]),
    );
    expect(params).toContain(
      JSON.stringify({
        commerceCancellation: {
          status: 'pending_provider_operation',
          providerOperationId: 'operation-1',
        },
      }),
    );
    expect(params).toEqual(expect.arrayContaining(['ver-1', 'org-1']));
    // The source follows the status being canceled, in the same statement.
    expect(query).toContain(
      `"cancellation_source" = CASE WHEN "verifications"."status" = 'no_whatsapp' THEN 'merchant_no_whatsapp' ELSE 'merchant_no_reply' END`,
    );
  });
});

describe('Dashboard insight SQL contract', () => {
  function build() {
    const execute = jest.fn<
      Promise<{ rows: unknown[][] }>,
      [string, unknown[]]
    >(() => Promise.resolve({ rows: [] }));
    const repository = new VerificationsRepository(
      drizzle(execute, { schema }) as never,
    );
    return { execute, repository };
  }
  const period = {
    startAt: '2026-09-01T00:00:00.000Z',
    endAt: '2026-10-01T00:00:00.000Z',
  };

  it("measures reply time from the first send to the customer's own answer", async () => {
    const { execute, repository } = build();
    await expect(repository.getReplyTiming('org-1', period)).resolves.toEqual({
      medianSeconds: null,
      replies: 0,
    });
    const [query, params] = execute.mock.calls[0];
    expect(query).toContain('percentile_cont(0.5) WITHIN GROUP');
    expect(query).toContain(
      `"verifications"."confirmation_source" IS DISTINCT FROM 'merchant_manual'`,
    );
    expect(query).toContain('"verifications"."last_sent_at" IS NOT NULL');
    expect(params).toContain('org-1');
  });

  it('groups a page of phones in one org-scoped query and skips an empty page', async () => {
    const { execute, repository } = build();
    await expect(
      repository.getCustomerHistoryByPhones('org-1', []),
    ).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();

    await repository.getCustomerHistoryByPhones('org-1', ['+201', '+202']);
    const [query, params] = execute.mock.calls[0];
    expect(query).toMatch(/"orders"\."org_id" = \$\d+/);
    expect(query).toMatch(/"orders"\."customer_phone" in \(\$\d+, \$\d+\)/);
    expect(query).toContain('group by "orders"."customer_phone"');
    expect(params).toEqual(expect.arrayContaining(['org-1', '+201', '+202']));
  });

  it('exports with the list filters, without test orders, up to the limit', async () => {
    const { execute, repository } = build();
    await repository.findForExport(
      'org-1',
      period,
      { tab: 'confirmed', searchDigits: '2074' },
      5001,
    );
    const [query, params] = execute.mock.calls[0];
    expect(query).toMatch(/"verifications"\."org_id" = \$\d+/);
    expect(query).toMatch(/"verifications"\."status" = \$\d+/);
    expect(query).toMatch(/"orders"\."is_test" = \$\d+/);
    expect(query).toMatch(/limit \$\d+/);
    expect(params).toEqual(
      expect.arrayContaining(['org-1', 'confirmed', '%2074%', 5001]),
    );
  });
});
