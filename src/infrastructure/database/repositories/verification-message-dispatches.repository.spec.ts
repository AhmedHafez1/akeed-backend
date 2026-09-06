import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../index';
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
}>;

function dispatchRow(overrides: DispatchOverrides = {}) {
  const {
    kind = 'initial',
    state = 'sending',
    usageReserved = false,
    usagePeriodStart = null,
    providerMessageId = null,
    acceptedAt = null,
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
    0, // attempt_count
    null, // last_error_code
    null, // lease_until
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
    return Promise.resolve({ rows: [] });
  });
  const session = drizzle(execute as never, { schema });
  const db = {
    transaction: (callback: (tx: unknown) => unknown) => callback(session),
  };
  const repository = new VerificationMessageDispatchesRepository(db as never);
  return { repository, statements };
}

function verificationUpdates(
  statements: { query: string; params: unknown[] }[],
) {
  return statements.filter((statement) =>
    statement.query.includes('update "verifications" set'),
  );
}

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
