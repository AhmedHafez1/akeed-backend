import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import {
  creditAccounts,
  integrationMonthlyUsage,
  verificationMessageDispatches,
  verificationSenderAttempts,
  whatsappConnections,
} from '../src/infrastructure/database/schema';
import { classifyOwnNumberFailure } from '../src/infrastructure/spokes/meta/own-number/own-number-send-failure.policy';
import type { ResolvedSender } from '../src/shared/ports/sender-resolver.port';
import type { SelectedCodTemplate } from '../src/shared/messaging/cod-template-selector';

const h = creditUsageHarness();
const repo = new VerificationMessageDispatchesRepository(h.db, h.router, {
  get: () => 'synthetic-shared-phone',
} as never);
const sql = readFileSync(
  resolve(__dirname, '../scripts/own-number-pilot-reconcile.sql'),
  'utf8',
);
const container = process.env.E09_TEST_POSTGRES_CONTAINER ?? '';
if (!/^[a-f0-9]{64}$/.test(container))
  throw new Error(
    'Run the disposable E09 reconciliation runner; no application database is used.',
  );
const selected: SelectedCodTemplate = {
  registryKey: 'synthetic.en.direct',
  variantKey: 'en.direct',
  language: 'en',
  templateName: 'synthetic_template',
  languageCode: 'en',
  parameterFormat: 'named',
  variables: [],
};

interface Report {
  orgId: string;
  consistent: boolean;
  pilotDispatches: number;
  historicalRowsWithoutBillingSnapshot: number;
  violations: { code: string; recordId: string }[];
  expectedDuplicateRisks: { classification: string }[];
  confirmedDuplicateGroups: { acceptedSends: number }[];
}

function reconcile(
  orgId: string,
  options: { start?: string; omit?: string; script?: string } = {},
) {
  const args = [
    'exec',
    '-i',
    container,
    'psql',
    '-X',
    '-qAt',
    '-h',
    '127.0.0.1',
    '-U',
    'e045_test',
    '-d',
    'akeed_e045_test',
  ];
  if (options.omit !== 'org_id') args.push('-v', `org_id=${orgId}`);
  if (options.omit !== 'pilot_start')
    args.push('-v', `pilot_start=${options.start ?? '2026-01-01T00:00:00Z'}`);
  const result = spawnSync('docker', args, {
    input: `SET search_path TO "${h.namespace}", public;\n${options.script ?? sql}`,
    encoding: 'utf8',
    windowsHide: true,
  });
  const json = result.stdout
    ?.split(/\r?\n/)
    .find((line) => line.startsWith('{'));
  return {
    code: result.status,
    output: result.stdout,
    error: result.stderr,
    report: json ? (JSON.parse(json) as Report) : undefined,
  };
}

function clean(orgId: string) {
  const result = reconcile(orgId);
  expect(result.error).toBe('');
  expect(result.report).toMatchObject({
    orgId,
    consistent: true,
    violations: [],
  });
  expect(result.code).toBe(0);
  return result.report!;
}

async function own(platform = 'standalone') {
  const source = await h.merchant(4, platform);
  const [connection] = await h.db
    .insert(whatsappConnections)
    .values({
      orgId: source.orgId,
      wabaId: randomUUID(),
      phoneNumberId: randomUUID(),
      signupPath: 'coexistence',
      state: 'active',
      businessTokenEncrypted: 'v1:synthetic:NEVER_PRINT_THIS',
    })
    .returning();
  const sender: ResolvedSender = {
    kind: 'merchant_own',
    connectionId: connection.id,
    reason: 'own_number',
    units: 1,
  };
  const input = await h.verification(source);
  const claim = await repo.claim({ ...input, sender });
  if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
  const attempt = await repo.beginMerchantAttempt(
    source.orgId,
    claim.dispatch.id,
    selected,
  );
  if (!attempt) throw new Error('Expected merchant attempt');
  await repo.authorizeMerchantAttempt(source.orgId, claim.dispatch.id, attempt);
  return {
    source,
    connection,
    sender,
    input,
    dispatch: claim.dispatch,
    attempt,
  };
}
type Fixture = Awaited<ReturnType<typeof own>>;

async function accept(f: Fixture) {
  await repo.acceptMerchantAttempt(
    f.source.orgId,
    f.dispatch.id,
    f.attempt,
    `wamid-${randomUUID()}`,
    new Date().toISOString(),
  );
}

async function fallback(f: Fixture) {
  await repo.failMerchantAttempt(
    f.source.orgId,
    f.dispatch.id,
    f.attempt,
    classifyOwnNumberFailure({ transport: true }),
  );
  const claimed = await repo.claim({
    ...f.input,
    sender: {
      kind: 'akeed_system',
      connectionId: null,
      reason: 'outcome_unknown',
      units: 1,
    },
    chargeRule: 'fallback',
    fallbackForDispatchId: f.dispatch.id,
  });
  if (claimed.outcome !== 'claimed') throw new Error(claimed.outcome);
  await h.acceptance(claimed.dispatch);
  return claimed.dispatch;
}

// Corruption is deliberately confined to the disposable schema. Runtime
// constraints remain enabled everywhere else; no production repair is tested.
async function corrupt(statement: string, values: string[]) {
  await h.client.begin(async (tx) => {
    await tx.unsafe("SET LOCAL session_replication_role = 'replica'");
    await tx.unsafe(statement, values);
  });
}

describe('read-only own-number pilot reconciliation over psql', () => {
  beforeAll(h.setup);
  afterAll(h.teardown);

  it('reconciles mixed prepaid sends, spare-funded sends and a legitimate reminder', async () => {
    const f = await own();
    await accept(f);
    const second = await repo.claim({
      ...(await h.verification(f.source)),
      sender: f.sender,
    });
    if (second.outcome !== 'claimed') throw new Error(second.outcome);
    await h.acceptance(second.dispatch);
    const reminder = await repo.claim({ ...f.input, kind: 'follow_up' });
    if (reminder.outcome !== 'claimed') throw new Error(reminder.outcome);
    await h.acceptance(reminder.dispatch);
    const before = await h.db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.orgId, f.source.orgId));
    expect(clean(f.source.orgId).confirmedDuplicateGroups).toEqual([]);
    expect(reconcile(f.source.orgId).output).not.toContain('NEVER_PRINT_THIS');
    expect(reconcile(f.source.orgId).output).not.toContain('+201000000000');
    expect(
      await h.db
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.orgId, f.source.orgId)),
    ).toEqual(before);
  });

  it('handles Shopify own and Akeed pools, cross-pool charging and plan resets', async () => {
    const f = await own('shopify');
    await accept(f);
    await h.db
      .update(integrationMonthlyUsage)
      .set({ ownNumberConsumed: 90 })
      .where(eq(integrationMonthlyUsage.integrationId, f.source.integrationId));
    const next = await repo.claim({
      ...(await h.verification(f.source)),
      sender: f.sender,
    });
    if (next.outcome !== 'claimed') throw new Error(next.outcome);
    expect(next.dispatch.billingPool).toBe('akeed');
    await h.acceptance(next.dispatch);
    clean(f.source.orgId);
    await h.db
      .update(integrationMonthlyUsage)
      .set({ consumedCount: 0, ownNumberConsumed: 0, includedLimit: 300 })
      .where(eq(integrationMonthlyUsage.integrationId, f.source.integrationId));
    clean(f.source.orgId);
  });

  it.each(['standalone', 'shopify'])(
    'allows only documented D3 duplicates on %s',
    async (platform) => {
      const f = await own(platform);
      await fallback(f);
      expect(clean(f.source.orgId).expectedDuplicateRisks).toMatchObject([
        { classification: 'possible' },
      ]);
      await repo.recordMerchantReceipt({
        providerMessageId: `late-${randomUUID()}`,
        attemptId: f.attempt.attemptId,
        phoneNumberId: f.connection.phoneNumberId,
        wabaId: f.connection.wabaId,
        status: 'sent',
        occurredAt: new Date().toISOString(),
      });
      const report = clean(f.source.orgId);
      expect(report.expectedDuplicateRisks).toMatchObject([
        { classification: 'confirmed' },
      ]);
      expect(report.confirmedDuplicateGroups).toMatchObject([
        { acceptedSends: 2 },
      ]);
    },
  );

  it.each(['unknown evidence', 'refund', 'fallback link'])(
    'rejects a duplicate when its D3 %s is missing',
    async (missing) => {
      const f = await own();
      const successor = await fallback(f);
      await repo.recordMerchantReceipt({
        providerMessageId: randomUUID(),
        attemptId: f.attempt.attemptId,
        phoneNumberId: f.connection.phoneNumberId,
        wabaId: f.connection.wabaId,
        status: 'sent',
        occurredAt: new Date().toISOString(),
      });
      clean(f.source.orgId);
      if (missing === 'unknown evidence')
        await corrupt(
          "UPDATE verification_message_dispatches SET last_error_code='190' WHERE id=$1",
          [f.dispatch.id],
        );
      else if (missing === 'refund')
        await corrupt(
          'UPDATE verification_message_dispatches SET billing_refunded_at=NULL WHERE id=$1',
          [f.dispatch.id],
        );
      else
        await corrupt(
          'UPDATE verification_message_dispatches SET fallback_for_dispatch_id=NULL WHERE id=$1',
          [successor.id],
        );
      const result = reconcile(f.source.orgId);
      expect(result.code).toBe(3);
      expect(result.report?.violations.map((v) => v.code)).toContain(
        'unexpected_duplicate',
      );
    },
  );

  it('uses lifetime pack evidence and detects a late duplicate across the pilot boundary', async () => {
    const f = await own();
    await corrupt(
      "UPDATE verification_message_dispatches SET created_at='2020-01-01' WHERE id=$1",
      [f.dispatch.id],
    );
    expect(clean(f.source.orgId).pilotDispatches).toBe(0);
    await fallback(f);
    await repo.recordMerchantReceipt({
      providerMessageId: randomUUID(),
      attemptId: f.attempt.attemptId,
      phoneNumberId: f.connection.phoneNumberId,
      wabaId: f.connection.wabaId,
      status: 'sent',
      occurredAt: new Date().toISOString(),
    });
    expect(clean(f.source.orgId).expectedDuplicateRisks).toMatchObject([
      { classification: 'confirmed' },
    ]);
  });

  it.each([0, 1, 2])(
    'reconciles prepaid fallback costing %s without debt',
    async (cost) => {
      const f = await own();
      await repo.failMerchantAttempt(
        f.source.orgId,
        f.dispatch.id,
        f.attempt,
        classifyOwnNumberFailure({ transport: true }),
      );
      if (cost < 2) {
        await h.adjust(f.source.orgId, -3);
        for (let index = 0; index < (cost === 1 ? 1 : 2); index++) {
          const claim = await repo.claim({
            ...(await h.verification(f.source)),
            sender: f.sender,
          });
          if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
          await h.acceptance(claim.dispatch);
        }
      }
      const claim = await repo.claim({
        ...f.input,
        sender: {
          kind: 'akeed_system',
          connectionId: null,
          reason: 'outcome_unknown',
          units: 1,
        },
        chargeRule: 'fallback',
        fallbackForDispatchId: f.dispatch.id,
      });
      if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
      expect(claim.dispatch.billingCost).toBe(cost);
      await h.acceptance(claim.dispatch);
      clean(f.source.orgId);
    },
  );

  it('handles exhausted Shopify fallback and billing-exempt test sends', async () => {
    const f = await own('shopify');
    await h.db
      .update(integrationMonthlyUsage)
      .set({ consumedCount: 30, ownNumberConsumed: 91 })
      .where(eq(integrationMonthlyUsage.integrationId, f.source.integrationId));
    expect((await fallback(f)).billingCost).toBe(0);
    const test = await repo.claim({
      ...(await h.verification(f.source)),
      sender: f.sender,
      billingExempt: true,
    });
    if (test.outcome !== 'claimed') throw new Error(test.outcome);
    await h.acceptance(test.dispatch);
    clean(f.source.orgId);
  });

  it('keeps an accepted retry separate from its confirmed failed attempt', async () => {
    const f = await own();
    await repo.failMerchantAttempt(
      f.source.orgId,
      f.dispatch.id,
      f.attempt,
      classifyOwnNumberFailure({ code: 131000 }),
    );
    await h.db
      .update(verificationMessageDispatches)
      .set({ senderRecoveryDueAt: '2020-01-01T00:00:00Z' })
      .where(eq(verificationMessageDispatches.id, f.dispatch.id));
    const next = await repo.beginMerchantAttempt(
      f.source.orgId,
      f.dispatch.id,
      selected,
      true,
    );
    if (!next) throw new Error('Expected retry');
    await repo.authorizeMerchantAttempt(f.source.orgId, f.dispatch.id, next);
    await repo.acceptMerchantAttempt(
      f.source.orgId,
      f.dispatch.id,
      next,
      randomUUID(),
      new Date().toISOString(),
    );
    clean(f.source.orgId);
  });

  it('detects an unapproved second accepted physical send', async () => {
    const f = await own();
    await accept(f);
    await h.db.insert(verificationSenderAttempts).values({
      orgId: f.source.orgId,
      dispatchId: f.dispatch.id,
      attemptNumber: 1,
      claimToken: randomUUID(),
      state: 'accepted',
      connectionId: f.connection.id,
      signupGeneration: 0,
      phoneNumberId: f.connection.phoneNumberId,
      wabaId: f.connection.wabaId,
      providerMessageId: randomUUID(),
      acceptedAt: new Date().toISOString(),
      leaseUntil: new Date().toISOString(),
    });
    const result = reconcile(f.source.orgId);
    expect(result.code).toBe(3);
    expect(result.report?.violations).toContainEqual({
      code: 'unexpected_duplicate',
      recordId: f.input.verificationId,
    });
  });

  it('detects sender, tenant and billing contradictions without exposing another tenant', async () => {
    const f = await own();
    const other = await own();
    await corrupt(
      'UPDATE verification_message_dispatches SET sender_connection_id=$1, integration_id=$2, sender_reason=NULL, billing_cost=2 WHERE id=$3',
      [other.connection.id, other.source.integrationId, f.dispatch.id],
    );
    const result = reconcile(f.source.orgId);
    expect(result.code).toBe(3);
    expect(result.report?.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining([
        'sender_identity',
        'dispatch_tenant_identity',
        'billing_snapshot',
        'spare_credit_mismatch',
      ]),
    );
    expect(result.output).not.toContain(other.source.orgId);
    clean(other.source.orgId);
  });

  it('detects lifetime account, reservation and refunded-charge contradictions', async () => {
    const f = await own();
    await repo.failMerchantAttempt(
      f.source.orgId,
      f.dispatch.id,
      f.attempt,
      classifyOwnNumberFailure({ code: 131026 }),
    );
    clean(f.source.orgId);
    await corrupt(
      'UPDATE verification_message_dispatches SET billing_refunded_at=NULL WHERE id=$1',
      [f.dispatch.id],
    );
    await corrupt(
      'UPDATE credit_accounts SET posted_balance=99, held_credits=1 WHERE org_id=$1',
      [f.source.orgId],
    );
    const codes = reconcile(f.source.orgId).report?.violations.map(
      (v) => v.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'refund_missing',
        'posted_balance_mismatch',
        'held_balance_mismatch',
        'spare_credit_mismatch',
      ]),
    );
    const shared = await h.merchant();
    const claim = await repo.claim(await h.verification(shared));
    if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
    await h.acceptance(claim.dispatch);
    await corrupt(
      'UPDATE credit_ledger_entries SET quantity=-2, posted_balance_after=posted_balance_before-2 WHERE dispatch_id=$1',
      [claim.dispatch.id],
    );
    expect(
      reconcile(shared.orgId).report?.violations.map((v) => v.code),
    ).toContain('reservation_ledger_mismatch');
  });

  it('reports historical missing snapshots without applying pilot rules retroactively', async () => {
    const f = await own('shopify');
    await corrupt(
      "UPDATE verification_message_dispatches SET billing_pool=NULL, billing_cost=NULL, sender_reason=NULL, created_at='2020-01-01' WHERE id=$1",
      [f.dispatch.id],
    );
    expect(clean(f.source.orgId).historicalRowsWithoutBillingSnapshot).toBe(1);
  });

  it('fails for missing/invalid inputs and rejects writes inside its transaction', async () => {
    const f = await own();
    for (const omit of ['org_id', 'pilot_start'])
      expect(reconcile(f.source.orgId, { omit }).code).toBe(3);
    expect(reconcile('invalid').code).toBe(3);
    expect(reconcile(f.source.orgId, { start: 'invalid' }).code).toBe(3);
    expect(reconcile(randomUUID()).report?.violations[0].code).toBe(
      'organization_missing',
    );
    expect(
      reconcile(f.source.orgId, { start: 'infinity' }).report?.violations[0]
        .code,
    ).toBe('invalid_pilot_start');
    const denied = reconcile(f.source.orgId, {
      script: sql.replace('COMMIT;', 'DELETE FROM organizations;\nCOMMIT;'),
    });
    expect(denied.code).toBe(3);
    expect(denied.error).toContain('read-only transaction');
    clean(f.source.orgId);
  });
});
