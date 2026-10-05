import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../index';
import { integrations, verificationMessageDispatches } from '../schema';
import { PeriodicPlanAccounting } from './periodic-plan-accounting';
import { UsageAccountingRouter } from './usage-accounting.router';
import {
  recordedDispatchTemplate,
  VerificationMessageDispatchesRepository,
} from './verification-message-dispatches.repository';

/**
 * US-08-02: the ledger records which template each send carried, at claim
 * time, and the acceptance mirrors it onto the verification. Rows written
 * before that keep the identity columns NULL and are never given a guess.
 */

const IDENTITY_COLUMNS = [
  'template_variant_key',
  'template_purpose',
  'meta_template_name',
  'meta_language_code',
  'resolved_language',
];

const EGYPTIAN = {
  variantKey: 'ar.egyptian',
  language: 'ar' as const,
  templateName: 'akeed_cod_verification_direct_eg',
  languageCode: 'ar_EG',
};

const RECORDED_GULF = {
  template_variant_key: 'ar.gulf',
  template_purpose: 'initial',
  meta_template_name: 'akeed_cod_verification_direct_gulf',
  meta_language_code: 'ar',
  resolved_language: 'ar',
};

type Statement = { query: string; params: unknown[] };

/** Built from the live column order, so it follows the schema. */
function dispatchRow(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    id: 'dispatch-1',
    org_id: 'org-1',
    integration_id: 'integration-1',
    verification_id: 'verification-1',
    dispatch_key: 'verification-1:initial:1',
    generation: 1,
    accounting_mode: 'periodic_plan',
    kind: 'initial',
    state: 'sending',
    sender_kind: 'akeed_system',
    usage_reserved: false,
    attempt_count: 0,
    metadata: {},
    created_at: '2026-05-15T00:00:00.000Z',
    updated_at: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
  return Object.values(getTableColumns(verificationMessageDispatches)).map(
    (column) => values[column.name] ?? null,
  );
}

function integrationRow(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    id: 'integration-1',
    org_id: 'org-1',
    platform_type: 'shopify',
    is_active: true,
    billing_status: 'active',
    billing_plan_id: 'starter',
    billing_activated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
  return Object.values(getTableColumns(integrations)).map(
    (column) => values[column.name] ?? null,
  );
}

function build(
  options: {
    /** What a select on the ledger returns; none means no row yet. */
    dispatch?: Record<string, unknown> | null;
    integration?: Record<string, unknown>;
    accounting?: unknown;
  } = {},
) {
  const statements: Statement[] = [];
  const execute = jest.fn((query: string, params: unknown[]) => {
    statements.push({ query, params });
    const lowered = query.trimStart();
    if (lowered.startsWith('select')) {
      if (query.includes('from "integrations"'))
        return Promise.resolve({
          rows: [integrationRow(options.integration)],
        });
      if (query.includes('from "credit_accounts"'))
        return Promise.resolve({ rows: [['org-1']] });
      if (query.includes('from "verifications"'))
        return Promise.resolve({ rows: [['verification-1']] });
      return Promise.resolve({
        rows: options.dispatch === null ? [] : [dispatchRow(options.dispatch)],
      });
    }
    if (lowered.startsWith('insert into "verification_message_dispatches"'))
      return Promise.resolve({
        rows: [
          dispatchRow({ state: 'ready', accounting_mode: 'prepaid_credit' }),
        ],
      });
    return Promise.resolve({ rows: [] });
  });
  const session = drizzle(execute as never, { schema });
  const db = Object.assign(session, {
    transaction: (callback: (tx: typeof session) => unknown) =>
      callback(session),
  });
  const repository = new VerificationMessageDispatchesRepository(
    db as never,
    (options.accounting ??
      new UsageAccountingRouter(
        {} as never,
        new PeriodicPlanAccounting(),
        {} as never,
      )) as never,
  );
  return { repository, statements };
}

function ledgerInserts(statements: Statement[]) {
  return statements.filter(({ query }) =>
    query.includes('insert into "verification_message_dispatches"'),
  );
}

function ledgerUpdates(statements: Statement[]) {
  return statements.filter(({ query }) =>
    query.includes('update "verification_message_dispatches" set'),
  );
}

function verificationUpdates(statements: Statement[]) {
  return statements.filter(({ query }) =>
    query.includes('update "verifications" set'),
  );
}

function setClause(statement: Statement) {
  return statement.query.split(' where ')[0];
}

const claimParams = {
  orgId: 'org-1',
  integrationId: 'integration-1',
  verificationId: 'verification-1',
  kind: 'initial' as const,
  templateName: EGYPTIAN.templateName,
  languageCode: EGYPTIAN.languageCode,
  identity: {
    variantKey: EGYPTIAN.variantKey,
    purpose: 'initial' as const,
    language: EGYPTIAN.language,
  },
  leaseUntil: '2999-01-01T00:00:00.000Z',
};

function expectIdentityWritten(statement: Statement, purpose: string) {
  for (const column of IDENTITY_COLUMNS)
    expect(setClause(statement)).toContain(`"${column}" = `);
  expect(setClause(statement)).toContain('"template_name" = ');
  expect(setClause(statement)).toContain('"language_code" = ');
  expect(statement.params).toEqual(
    expect.arrayContaining([
      EGYPTIAN.variantKey,
      purpose,
      EGYPTIAN.templateName,
      EGYPTIAN.languageCode,
      EGYPTIAN.language,
    ]),
  );
}

describe('VerificationMessageDispatchesRepository template identity at claim', () => {
  it('writes every identity field when a plan-billed send is claimed', async () => {
    const { repository, statements } = build({ dispatch: { state: 'ready' } });

    await expect(repository.claim(claimParams)).resolves.toMatchObject({
      outcome: 'claimed',
    });

    // The row is created with the identity, and the claim restates it.
    const [insert] = ledgerInserts(statements);
    expect(insert.params).toEqual(
      expect.arrayContaining([
        EGYPTIAN.variantKey,
        'initial',
        EGYPTIAN.templateName,
        EGYPTIAN.languageCode,
        EGYPTIAN.language,
      ]),
    );
    const updates = ledgerUpdates(statements);
    expect(updates).toHaveLength(1);
    expectIdentityWritten(updates[0], 'initial');
  });

  it('records a billing-exempt test claim as a test', async () => {
    const { repository, statements } = build({ dispatch: { state: 'ready' } });

    await repository.claim({
      ...claimParams,
      billingExempt: true,
      identity: { ...claimParams.identity, purpose: 'test' },
    });

    const updates = ledgerUpdates(statements);
    expect(updates).toHaveLength(1);
    expect(setClause(updates[0])).toContain('"metadata"');
    expectIdentityWritten(updates[0], 'test');
  });

  it('records a follow-up claim as a reminder', async () => {
    const { repository, statements } = build({
      dispatch: {
        state: 'ready',
        kind: 'follow_up',
        dispatch_key: 'verification-1:follow_up:1',
      },
    });

    await repository.claim({
      ...claimParams,
      kind: 'follow_up',
      identity: { ...claimParams.identity, purpose: 'reminder' },
    });

    const updates = ledgerUpdates(statements);
    expect(updates).toHaveLength(1);
    expectIdentityWritten(updates[0], 'reminder');
  });

  it('writes every identity field when a prepaid-credit send is claimed', async () => {
    const accounting = {
      mode: () => 'prepaid_credit',
      newHoldDenial: jest.fn().mockResolvedValue(null),
      prepaid: {
        lock: jest.fn().mockResolvedValue(undefined),
        hold: jest.fn().mockResolvedValue(undefined),
      },
    };
    const { repository, statements } = build({
      dispatch: null,
      integration: { platform_type: 'standalone' },
      accounting,
    });

    await repository.claim(claimParams);

    expect(accounting.prepaid.hold).toHaveBeenCalledTimes(1);
    const [insert] = ledgerInserts(statements);
    expect(insert.params).toEqual(
      expect.arrayContaining([
        'prepaid_credit',
        EGYPTIAN.variantKey,
        'initial',
        EGYPTIAN.templateName,
        EGYPTIAN.languageCode,
        EGYPTIAN.language,
      ]),
    );
    const updates = ledgerUpdates(statements);
    expect(updates).toHaveLength(1);
    expectIdentityWritten(updates[0], 'initial');
  });

  it('records no identity for a claim that names none', async () => {
    const { repository, statements } = build({ dispatch: { state: 'ready' } });

    await repository.claim({ ...claimParams, identity: undefined });

    const [update] = ledgerUpdates(statements);
    for (const column of IDENTITY_COLUMNS)
      expect(setClause(update)).not.toContain(`"${column}"`);
  });
});

describe('VerificationMessageDispatchesRepository template identity at acceptance', () => {
  const acceptance = {
    dispatchId: 'dispatch-1',
    providerMessageId: 'wamid-1',
    sentAt: '2026-05-15T00:10:00.000Z',
    verificationId: 'verification-1',
    kind: 'initial' as const,
  };

  it('stamps what the adapter sent on the dispatch and the verification together', async () => {
    const { repository, statements } = build({ dispatch: RECORDED_GULF });

    await repository.markAccepted({ ...acceptance, sentTemplate: EGYPTIAN });

    const [ledger] = ledgerUpdates(statements);
    expect(ledger.params).toContain('accepted');
    for (const column of IDENTITY_COLUMNS.filter(
      (name) => name !== 'template_purpose',
    ))
      expect(setClause(ledger)).toContain(`"${column}" = `);
    // The purpose is a fact about the claim; an acceptance does not restate it.
    expect(setClause(ledger)).not.toContain('"template_purpose"');
    expect(ledger.params).toEqual(
      expect.arrayContaining([
        EGYPTIAN.variantKey,
        EGYPTIAN.templateName,
        EGYPTIAN.languageCode,
      ]),
    );

    const [verification] = verificationUpdates(statements);
    expect(setClause(verification)).toContain('"wa_message_id" = ');
    expect(setClause(verification)).toContain('"template_name" = ');
    expect(setClause(verification)).toContain('"language_code" = ');
    expect(verification.params).toEqual(
      expect.arrayContaining([
        'wamid-1',
        EGYPTIAN.templateName,
        EGYPTIAN.languageCode,
      ]),
    );
  });

  it('projects the claimed identity when the acceptance reports none', async () => {
    // A staff resolution of an unknown outcome: no adapter result exists.
    const { repository, statements } = build({
      dispatch: { ...RECORDED_GULF, state: 'outcome_unknown' },
    });

    await repository.markAccepted(acceptance);

    const [ledger] = ledgerUpdates(statements);
    for (const column of IDENTITY_COLUMNS)
      expect(setClause(ledger)).not.toContain(`"${column}"`);
    const [verification] = verificationUpdates(statements);
    expect(verification.params).toEqual(
      expect.arrayContaining(['akeed_cod_verification_direct_gulf', 'ar']),
    );
  });

  it('projects a reminder onto the verification as its latest accepted send', async () => {
    const { repository, statements } = build({
      dispatch: { kind: 'follow_up' },
    });

    await repository.markAccepted({
      ...acceptance,
      kind: 'follow_up',
      sentTemplate: EGYPTIAN,
    });

    const [verification] = verificationUpdates(statements);
    expect(setClause(verification)).toContain('"follow_up_sent_at" = ');
    expect(verification.params).toEqual(
      expect.arrayContaining([EGYPTIAN.templateName, EGYPTIAN.languageCode]),
    );
  });

  it('writes no template onto the verification for a row that never recorded one', async () => {
    const { repository, statements } = build({
      dispatch: { state: 'outcome_unknown' },
    });

    await repository.markAccepted(acceptance);

    const [verification] = verificationUpdates(statements);
    expect(setClause(verification)).toContain('"wa_message_id" = ');
    expect(setClause(verification)).not.toContain('"template_name"');
    expect(setClause(verification)).not.toContain('"language_code"');
  });

  it('repairs a lagging verification from the stored identity only', async () => {
    const { repository, statements } = build({
      dispatch: {
        ...RECORDED_GULF,
        state: 'accepted',
        provider_message_id: 'wamid-1',
        accepted_at: '2026-05-15T00:05:00.000Z',
      },
    });

    // A repair restates the original send; a template passed now is ignored.
    await repository.markAccepted({ ...acceptance, sentTemplate: EGYPTIAN });

    expect(ledgerUpdates(statements)).toHaveLength(0);
    const [verification] = verificationUpdates(statements);
    expect(verification.params).toEqual(
      expect.arrayContaining(['akeed_cod_verification_direct_gulf', 'ar']),
    );
    expect(verification.params).not.toContain(EGYPTIAN.templateName);
  });

  it('gives the verification its template when the ledger row could not be written', async () => {
    const { repository, statements } = build();

    await repository.projectAcceptanceWithoutLedger({
      verificationId: 'verification-1',
      kind: 'initial',
      providerMessageId: 'wamid-1',
      sentAt: acceptance.sentAt,
      template: EGYPTIAN,
    });

    const [verification] = verificationUpdates(statements);
    expect(verification.params).toEqual(
      expect.arrayContaining([
        'wamid-1',
        EGYPTIAN.templateName,
        EGYPTIAN.languageCode,
      ]),
    );
  });
});

describe('VerificationMessageDispatchesRepository template identity is kept', () => {
  it.each([
    [
      'a provider call with no message id',
      (repository: VerificationMessageDispatchesRepository) =>
        repository.markFailedProviderOutcome(
          'dispatch-1',
          'provider_exception',
        ),
    ],
    [
      'an acceptance that could not be persisted',
      (repository: VerificationMessageDispatchesRepository) =>
        repository.markOutcomeUnknown(
          'dispatch-1',
          'acceptance_persistence_failed',
          'wamid-1',
        ),
    ],
    [
      'a confirmed rejection',
      (repository: VerificationMessageDispatchesRepository) =>
        repository.resolveNotAccepted('dispatch-1', undefined, true),
    ],
  ])('through %s', async (_label, act) => {
    const { repository, statements } = build({ dispatch: RECORDED_GULF });

    await act(repository);

    const updates = ledgerUpdates(statements);
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      for (const column of IDENTITY_COLUMNS)
        expect(setClause(update)).not.toContain(`"${column}"`);
      expect(setClause(update)).not.toContain('"template_name"');
      expect(setClause(update)).not.toContain('"language_code"');
    }
  });
});

describe('recordedDispatchTemplate', () => {
  it('reads the identity a dispatch recorded', () => {
    expect(
      recordedDispatchTemplate({
        templateVariantKey: 'ar.gulf',
        metaTemplateName: 'akeed_cod_verification_direct_gulf',
        metaLanguageCode: 'ar',
        resolvedLanguage: 'ar',
      }),
    ).toEqual({
      variantKey: 'ar.gulf',
      language: 'ar',
      templateName: 'akeed_cod_verification_direct_gulf',
      languageCode: 'ar',
    });
  });

  it.each([
    ['a row written before identity was recorded', {}],
    [
      'a row with only the old placeholder columns',
      { templateVariantKey: null, metaTemplateName: null },
    ],
    [
      'a partly filled row',
      { templateVariantKey: 'ar.gulf', metaTemplateName: null },
    ],
  ])('reports %s as not recorded', (_label, dispatch) => {
    expect(recordedDispatchTemplate(dispatch)).toBeUndefined();
  });
});
