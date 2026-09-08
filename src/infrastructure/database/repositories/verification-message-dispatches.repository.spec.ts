import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../index';
import { integrations } from '../schema';
import { VerificationMessageDispatchesRepository } from './verification-message-dispatches.repository';

/**
 * The dispatch ledger projects send outcomes onto the `verifications` row.
 * Those projections run outside `VerificationsRepository.updateStatus`, so they
 * carry their own terminal-status protection. Without it a customer's
 * `confirmed` reply is silently reverted to `sent` whenever provider acceptance
 * commits afterwards — including days later, when an operator resolves an
 * `outcome_unknown` dispatch from the admin console.
 */

type DispatchOverrides = Partial<{
  kind: 'initial' | 'follow_up';
  state: string;
  usageReserved: boolean;
  usagePeriodStart: string | null;
  providerMessageId: string | null;
  acceptedAt: string | null;
  attemptCount: number;
  leaseUntil: string | null;
}>;

function dispatchRow(overrides: DispatchOverrides = {}) {
  const {
    kind = 'initial',
    state = 'sending',
    usageReserved = false,
    usagePeriodStart = null,
    providerMessageId = null,
    acceptedAt = null,
    attemptCount = 0,
    leaseUntil = null,
  } = overrides;
  // Column order must match the `verification_message_dispatches` table.
  return [
    'dispatch-1', // id
    'org-1', // org_id
    'integration-1', // integration_id
    'verification-1', // verification_id
    'verification-1:initial:1', // dispatch_key
    kind,
    state,
    'akeed_system', // sender_kind
    'cod_verification', // template_name
    'ar', // language_code
    providerMessageId, // provider_message_id
    usagePeriodStart, // usage_period_start
    usageReserved,
    attemptCount, // attempt_count
    null, // last_error_code
    leaseUntil, // lease_until
    acceptedAt, // accepted_at
    null, // delivered_at
    null, // read_at
    null, // failed_at
    null, // resolved_at
    {}, // metadata
    '2026-05-15T00:00:00.000Z', // created_at
    '2026-05-15T00:00:00.000Z', // updated_at
  ];
}

/**
 * pg-proxy has no transaction support, so route the repository's transaction
 * callback at a proxy-backed session and capture the SQL it emits.
 */
function buildRepository(overrides: DispatchOverrides = {}) {
  const statements: { query: string; params: unknown[] }[] = [];
  const execute = jest.fn((query: string, params: unknown[]) => {
    statements.push({ query, params });
    if (query.trimStart().startsWith('select')) {
      return Promise.resolve({ rows: [dispatchRow(overrides)] });
    }
    if (
      query.includes('update "integration_monthly_usage" set') &&
      query.trimEnd().endsWith('returning "id"')
    ) {
      return Promise.resolve({ rows: [['usage-1']] });
    }
    if (
      query.includes('update "verification_message_dispatches" set') &&
      query.trimEnd().endsWith('returning "id"')
    ) {
      return Promise.resolve({ rows: [['dispatch-1']] });
    }
    return Promise.resolve({ rows: [] });
  });
  const session = drizzle(execute as never, { schema });
  const db = Object.assign(session, {
    transaction: (callback: (tx: typeof session) => unknown) =>
      callback(session),
  });
  const repository = new VerificationMessageDispatchesRepository(db as never);
  return { repository, statements };
}

function buildAcceptanceRecoveryRepository(options: {
  recoverByDispatchKey: boolean;
  verificationExists: boolean;
}) {
  const statements: { query: string; params: unknown[] }[] = [];
  let dispatchSelectCount = 0;
  const execute = jest.fn((query: string, params: unknown[]) => {
    statements.push({ query, params });
    if (
      query.trimStart().startsWith('select') &&
      query.includes('from "verification_message_dispatches"')
    ) {
      dispatchSelectCount += 1;
      return Promise.resolve({
        rows:
          dispatchSelectCount === 2 && options.recoverByDispatchKey
            ? [dispatchRow()]
            : [],
      });
    }
    if (
      query.trimStart().startsWith('select') &&
      query.includes('from "verifications"')
    ) {
      return Promise.resolve({
        rows: options.verificationExists ? [['verification-1']] : [],
      });
    }
    if (query.includes('update "verification_message_dispatches" set')) {
      return Promise.resolve({
        rows: [
          dispatchRow({
            state: 'accepted',
            providerMessageId: 'wamid-recovered',
            acceptedAt: '2026-05-15T00:10:00.000Z',
          }),
        ],
      });
    }
    return Promise.resolve({ rows: [] });
  });
  const session = drizzle(execute as never, { schema });
  const db = {
    transaction: (callback: (tx: unknown) => unknown) => callback(session),
  };
  return {
    repository: new VerificationMessageDispatchesRepository(db as never),
    statements,
  };
}

function verificationUpdates(
  statements: { query: string; params: unknown[] }[],
) {
  return statements.filter((statement) =>
    statement.query.includes('update "verifications" set'),
  );
}

/**
 * An entitled Standalone source, built from the live column order so the
 * fixture cannot drift out of sync with the schema.
 */
function integrationRow() {
  const values: Record<string, unknown> = {
    id: 'integration-1',
    org_id: 'org-1',
    platform_type: 'standalone',
    is_active: true,
    billing_status: 'not_required',
    billing_plan_id: 'starter',
    billing_activated_at: '2026-05-01T00:00:00.000Z',
  };
  return Object.values(getTableColumns(integrations)).map(
    (column) => values[column.name] ?? null,
  );
}

/**
 * Like {@link buildRepository}, but answers the `integrations` lookup that the
 * claim path makes so entitlement resolves.
 */
function buildClaimRepository(overrides: DispatchOverrides = {}) {
  const statements: { query: string; params: unknown[] }[] = [];
  const execute = jest.fn((query: string, params: unknown[]) => {
    statements.push({ query, params });
    if (!query.trimStart().startsWith('select')) {
      return Promise.resolve({ rows: [] });
    }
    if (query.includes('from "integrations"')) {
      return Promise.resolve({ rows: [integrationRow()] });
    }
    return Promise.resolve({ rows: [dispatchRow(overrides)] });
  });
  const session = drizzle(execute as never, { schema });
  const db = {
    transaction: (callback: (tx: unknown) => unknown) => callback(session),
  };
  const repository = new VerificationMessageDispatchesRepository(db as never);
  return { repository, statements };
}

function dispatchUpdates(statements: { query: string; params: unknown[] }[]) {
  return statements.filter((statement) =>
    statement.query.includes('update "verification_message_dispatches" set'),
  );
}

const EXPIRED_LEASE = '2026-05-15T00:00:00.000Z';

describe('VerificationMessageDispatchesRepository acceptance recovery', () => {
  const acceptance = {
    dispatchId: 'stale-dispatch-id',
    verificationId: 'verification-1',
    kind: 'initial' as const,
    providerMessageId: 'wamid-recovered',
    sentAt: '2026-05-15T00:10:00.000Z',
  };

  it('recovers an id miss through the stable dispatch key', async () => {
    const { repository, statements } = buildAcceptanceRecoveryRepository({
      recoverByDispatchKey: true,
      verificationExists: true,
    });

    await expect(repository.markAccepted(acceptance)).resolves.toMatchObject({
      outcome: 'accepted',
    });

    const dispatchSelects = statements.filter(
      ({ query }) =>
        query.trimStart().startsWith('select') &&
        query.includes('from "verification_message_dispatches"'),
    );
    expect(dispatchSelects).toHaveLength(2);
    expect(dispatchSelects[1].query).toContain('"dispatch_key"');
    expect(dispatchSelects[1].params).toContain('verification-1:initial:1');
  });

  it('distinguishes a deleted verification from a missing dispatch row', async () => {
    const { repository } = buildAcceptanceRecoveryRepository({
      recoverByDispatchKey: false,
      verificationExists: false,
    });

    await expect(repository.markAccepted(acceptance)).resolves.toEqual({
      outcome: 'verification_missing',
    });
  });
});

/**
 * An expired lease means the worker holding the send died before it recorded an
 * acceptance. Parking the dispatch at `outcome_unknown` stranded the
 * verification at `pending` for good: every later claim then returned early
 * without sending, and only staff resolution could free it.
 */
describe('VerificationMessageDispatchesRepository lease reclaim', () => {
  const claimParams = {
    orgId: 'org-1',
    integrationId: 'integration-1',
    verificationId: 'verification-1',
    kind: 'initial' as const,
    templateName: 'cod_verification',
    languageCode: 'ar',
    leaseUntil: '2999-01-01T00:00:00.000Z',
  };

  it('re-claims a send whose lease expired instead of parking it', async () => {
    const { repository, statements } = buildClaimRepository({
      state: 'sending',
      leaseUntil: EXPIRED_LEASE,
      attemptCount: 1,
      usageReserved: true,
      usagePeriodStart: '2026-05-01T00:00:00.000Z',
    });

    const result = await repository.claim(claimParams);

    expect(result.outcome).toBe('claimed');
    const updates = dispatchUpdates(statements);
    expect(updates).toHaveLength(1);
    expect(updates[0].query).toContain('"state" = $');
    // The reclaim keeps the reason the previous attempt was abandoned; it is
    // the only trace that this send is a retry rather than a first try.
    expect(updates[0].params).toContain('dispatch_lease_expired');
    expect(updates[0].params).toContain('sending');
    // The usage was reserved by the original claim, so re-claiming must not
    // charge the merchant a second time for one logical send.
    expect(
      statements.some((statement) =>
        statement.query.includes('integration_monthly_usage'),
      ),
    ).toBe(false);
  });

  it('parks the dispatch once the reclaim budget is spent', async () => {
    const { repository, statements } = buildClaimRepository({
      state: 'sending',
      leaseUntil: EXPIRED_LEASE,
      attemptCount: 2,
      usageReserved: true,
    });

    const result = await repository.claim(claimParams);

    expect(result.outcome).toBe('outcome_unknown');
    const updates = dispatchUpdates(statements);
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toContain('outcome_unknown');
  });

  it('leaves a dispatch alone while its lease is still live', async () => {
    const { repository, statements } = buildClaimRepository({
      state: 'sending',
      leaseUntil: '2999-01-01T00:00:00.000Z',
      attemptCount: 1,
      usageReserved: true,
    });

    const result = await repository.claim(claimParams);

    expect(result.outcome).toBe('busy');
    expect(dispatchUpdates(statements)).toHaveLength(0);
  });
});

describe('VerificationMessageDispatchesRepository usage refunds', () => {
  const periodStart = '2026-05-01';

  it.each(['initial', 'follow_up'] as const)(
    'atomically refunds a failed %s provider call and projects its failure',
    async (kind) => {
      const { repository, statements } = buildRepository({
        kind,
        usageReserved: true,
        usagePeriodStart: periodStart,
      });

      await expect(
        repository.markFailedProviderOutcome(
          'dispatch-1',
          'provider_exception',
        ),
      ).resolves.toBe(1);

      const [usageUpdate] = statements.filter((statement) =>
        statement.query.includes('update "integration_monthly_usage" set'),
      );
      expect(usageUpdate?.query).toContain(
        'GREATEST("integration_monthly_usage"."consumed_count" - 1, 0)',
      );
      expect(usageUpdate?.params).toEqual(
        expect.arrayContaining(['integration-1', periodStart]),
      );

      const [dispatchUpdate] = dispatchUpdates(statements);
      expect(dispatchUpdate.params).toEqual(
        expect.arrayContaining([
          'outcome_unknown',
          false,
          'provider_exception',
        ]),
      );

      const [verificationUpdate] = verificationUpdates(statements);
      expect(verificationUpdate).toBeDefined();
      if (kind === 'initial') {
        expect(verificationUpdate.params).toContain('failed');
        expect(verificationUpdate.params).toContain(
          JSON.stringify({
            reason: 'provider_outcome_unknown',
            kind: 'initial',
          }),
        );
      } else {
        expect(verificationUpdate.query).not.toContain(
          "'failed'::verification_status",
        );
        expect(verificationUpdate.params).toEqual(
          expect.arrayContaining([expect.stringContaining('follow_up_failed')]),
        );
      }
    },
  );

  it('does not refund an already released provider failure twice', async () => {
    const { repository, statements } = buildRepository({
      usageReserved: false,
      usagePeriodStart: periodStart,
    });

    await repository.markFailedProviderOutcome(
      'dispatch-1',
      'provider_exception',
    );

    expect(
      statements.some((statement) =>
        statement.query.includes('update "integration_monthly_usage" set'),
      ),
    ).toBe(false);
  });

  it('refunds a Meta failed status exactly once', async () => {
    const { repository, statements } = buildRepository({
      state: 'accepted',
      usageReserved: true,
      usagePeriodStart: periodStart,
    });

    await repository.recordProviderStatus(
      'dispatch-1',
      'failed',
      '2026-05-15T03:00:00.000Z',
    );

    const usageUpdates = statements.filter((statement) =>
      statement.query.includes('update "integration_monthly_usage" set'),
    );
    expect(usageUpdates).toHaveLength(1);
    expect(usageUpdates[0].query).toContain('GREATEST');
    const [dispatchUpdate] = dispatchUpdates(statements);
    expect(dispatchUpdate.params).toEqual(
      expect.arrayContaining([false, '2026-05-15T03:00:00.000Z']),
    );
  });

  it('does not decrement usage for a duplicate Meta failure', async () => {
    const { repository, statements } = buildRepository({
      state: 'accepted',
      usageReserved: false,
      usagePeriodStart: periodStart,
    });

    await repository.recordProviderStatus(
      'dispatch-1',
      'failed',
      '2026-05-15T03:00:00.000Z',
    );

    expect(
      statements.some((statement) =>
        statement.query.includes('update "integration_monthly_usage" set'),
      ),
    ).toBe(false);
  });

  it('restores a refunded unknown dispatch when staff resolves it as accepted', async () => {
    const { repository, statements } = buildRepository({
      state: 'outcome_unknown',
      usageReserved: false,
      usagePeriodStart: periodStart,
    });

    await expect(
      repository.markAccepted({
        dispatchId: 'dispatch-1',
        providerMessageId: 'wamid-resolved',
        sentAt: '2026-05-15T04:00:00.000Z',
      }),
    ).resolves.toMatchObject({ outcome: 'accepted' });

    const [usageUpdate] = statements.filter((statement) =>
      statement.query.includes('update "integration_monthly_usage" set'),
    );
    expect(usageUpdate.query).toContain(
      '"integration_monthly_usage"."consumed_count" + 1',
    );
    expect(usageUpdate.params).toEqual(
      expect.arrayContaining(['integration-1', periodStart]),
    );
    const [dispatchUpdate] = dispatchUpdates(statements);
    expect(dispatchUpdate.params).toContain(true);
  });

  it('keeps successful provider statuses counted', async () => {
    const { repository, statements } = buildRepository({
      state: 'accepted',
      usageReserved: true,
      usagePeriodStart: periodStart,
    });

    await repository.recordProviderStatus(
      'dispatch-1',
      'delivered',
      '2026-05-15T03:00:00.000Z',
    );

    expect(
      statements.some((statement) =>
        statement.query.includes('update "integration_monthly_usage" set'),
      ),
    ).toBe(false);
  });
});

describe('VerificationMessageDispatchesRepository terminal-state protection', () => {
  it('does not regress a terminal status when an initial send is accepted', async () => {
    const { repository, statements } = buildRepository();

    await repository.markAccepted({
      dispatchId: 'dispatch-1',
      providerMessageId: 'wamid-1',
      sentAt: '2026-05-15T00:10:00.000Z',
    });

    const [update] = verificationUpdates(statements);
    expect(update).toBeDefined();

    // The status is written through a CASE that preserves an existing terminal
    // value rather than overwriting it with 'sent'.
    expect(update.query).toMatch(
      /"status" = CASE\s+WHEN "verifications"\."status" IN \('confirmed', 'canceled'\) THEN "verifications"\."status"/,
    );

    // ...while the send facts are still recorded, because the message really
    // was accepted by the provider and both audit and billing depend on them.
    expect(update.query).toMatch(/"wa_message_id" = \$\d+/);
    expect(update.query).toMatch(/"last_sent_at" = \$\d+/);
    expect(update.query).toContain(
      'COALESCE("verifications"."attempts", 0) + 1',
    );
    expect(update.params).toEqual(
      expect.arrayContaining(['wamid-1', '2026-05-15T00:10:00.000Z']),
    );
  });

  it('does not repoint message identity on a terminal verification for follow-ups', async () => {
    const { repository, statements } = buildRepository({ kind: 'follow_up' });

    await repository.markAccepted({
      dispatchId: 'dispatch-1',
      providerMessageId: 'wamid-follow-up',
      sentAt: '2026-05-15T02:00:00.000Z',
    });

    const [update] = verificationUpdates(statements);
    expect(update).toBeDefined();
    expect(update.query).toMatch(
      /"verifications"\."status" not in \(\$\d+, \$\d+\)/,
    );
    expect(update.params).toEqual(
      expect.arrayContaining(['confirmed', 'canceled']),
    );
    // A follow-up carries a floor, not an assignment: an accepted reminder
    // proves a message went out, so the row must not keep claiming `pending`,
    // but a row already at `delivered`/`read` keeps the further state it earned.
    expect(update.query).toMatch(
      /"status" = CASE\s+WHEN "verifications"\."status" IS NULL OR "verifications"\."status" = 'pending'\s+THEN 'sent'::verification_status\s+ELSE "verifications"\."status"/,
    );
  });

  it('repairs a verification left behind by an already-accepted dispatch', async () => {
    // The reported bug: the ledger says the message was accepted, the
    // verification still says `pending`, and because the dispatch is already
    // `accepted` no send will ever run again to fix it. `markAccepted` must
    // project on this path instead of returning early, or the row stays wrong
    // forever and the merchant is told nobody was contacted.
    const { repository, statements } = buildRepository({
      state: 'accepted',
      providerMessageId: 'wamid-original',
      acceptedAt: '2026-05-15T00:10:00.000Z',
    });

    await repository.markAccepted({
      dispatchId: 'dispatch-1',
      providerMessageId: 'wamid-ignored',
      sentAt: '2026-06-01T00:00:00.000Z',
    });

    const [update] = verificationUpdates(statements);
    expect(update).toBeDefined();

    // A floor, never an assignment: a row that already reached `delivered` or
    // `read` must not be dragged back to `sent` by the repair.
    expect(update.query).toMatch(
      /"status" = CASE\s+WHEN "verifications"\."status" IS NULL OR "verifications"\."status" = 'pending'\s+THEN 'sent'::verification_status\s+ELSE "verifications"\."status"/,
    );

    // The original acceptance facts are restored, not today's clock, and the
    // attempt counter is untouched — nothing new was actually sent.
    expect(update.params).toEqual(
      expect.arrayContaining(['wamid-original', '2026-05-15T00:10:00.000Z']),
    );
    expect(update.params).not.toEqual(
      expect.arrayContaining(['wamid-ignored']),
    );
    expect(update.query).not.toContain(
      'COALESCE("verifications"."attempts", 0) + 1',
    );
  });

  it('leaves the ledger row alone while repairing the projection', async () => {
    // The repair must not restamp `accepted_at` or re-resolve the dispatch;
    // only the lagging verification projection is being corrected.
    const { repository, statements } = buildRepository({
      state: 'accepted',
      providerMessageId: 'wamid-original',
      acceptedAt: '2026-05-15T00:10:00.000Z',
    });

    await repository.markAccepted({
      dispatchId: 'dispatch-1',
      providerMessageId: 'wamid-ignored',
      sentAt: '2026-06-01T00:00:00.000Z',
    });

    const ledgerUpdates = statements.filter((statement) =>
      statement.query.includes('update "verification_message_dispatches" set'),
    );
    expect(ledgerUpdates).toHaveLength(0);
  });

  it('does not regress a terminal status when a dispatch is resolved as not accepted', async () => {
    const { repository, statements } = buildRepository({
      state: 'outcome_unknown',
    });

    await repository.resolveNotAccepted('dispatch-1');

    const [update] = verificationUpdates(statements);
    expect(update).toBeDefined();
    expect(update.query).toMatch(
      /"status" = CASE\s+WHEN "verifications"\."status" IN \('confirmed', 'canceled'\) THEN "verifications"\."status"/,
    );
    expect(update.params).toEqual(
      expect.arrayContaining([
        JSON.stringify({ reason: 'provider_not_accepted', kind: 'initial' }),
      ]),
    );
  });
});
