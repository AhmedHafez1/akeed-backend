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
}>;

function dispatchRow(overrides: DispatchOverrides = {}) {
  const {
    kind = 'initial',
    state = 'sending',
    usageReserved = false,
    usagePeriodStart = null,
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
    null, // provider_message_id
    usagePeriodStart, // usage_period_start
    usageReserved,
    0, // attempt_count
    null, // last_error_code
    null, // lease_until
    null, // accepted_at
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
    // A follow-up never advances the lifecycle status.
    expect(update.query).not.toMatch(/set[^]*"status" =/);
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
