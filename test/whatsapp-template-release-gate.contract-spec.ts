import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as tables from '../src/infrastructure/database/schema';
import { IntegrationMonthlyUsageRepository } from '../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import { WhatsappTemplateSyncRepository } from '../src/infrastructure/database/repositories/whatsapp-template-sync.repository';
import { WhatsappTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-templates.repository';
import { MetaTemplateCatalogAdapter } from '../src/infrastructure/spokes/meta/meta-template-catalog.adapter';
import { WhatsAppService } from '../src/infrastructure/spokes/meta/whatsapp.service';
import { TemplateAlertService } from '../src/modules/template-registry/template-alert.service';
import { TemplateRegistryService } from '../src/modules/template-registry/template-registry.service';
import { WhatsappTemplateSyncService } from '../src/modules/template-registry/whatsapp-template-sync.service';
import { BillingEntitlementService } from '../src/modules/verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../src/modules/verification-core/credit-eligibility.service';
import { VerificationSendService } from '../src/modules/verification-core/verification-send.service';
import { parseWhatsappTemplateConfig } from '../src/shared/config/whatsapp-template.config';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import {
  FAKE_MESSAGES_TOKEN,
  FAKE_PHONE_NUMBER_ID,
  FakeMetaMessagesApi,
} from './contracts/meta-messages-fake';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  FakeMetaTemplateApi,
  akeedTemplates,
} from './contracts/meta-template-api-fake';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';

/**
 * US-08-08 criterion 5, end to end over PostgreSQL: the send guardrail.
 *
 * Meta is two in-process fakes built from the contract record. A template's
 * status changes at the fake, the real sync writes it to the registry, and
 * the real send service, registry, dispatch ledger and usage accounting run
 * against it. What reaches the `messages` fake is what a customer would get.
 *
 * - A template that is paused, disabled, rejected, missing or switched off
 *   is never sent (record 4.2.5 and the "sendable" worst-case rule).
 * - The language default stands in, and the dispatch says why.
 * - With no sendable default the send is skipped before the claim: no
 *   dispatch row, and no usage or credit is taken.
 */
const harness = creditUsageHarness();
const { db, client, dispatches } = harness;

const TEMPLATE_MIGRATIONS = [
  '0054_whatsapp_templates_registry.sql',
  '0055_integration_template_keys.sql',
  '0057_whatsapp_template_sync.sql',
  '0058_whatsapp_template_authoring.sql',
  '0059_whatsapp_reminder_and_auto_style.sql',
];

const AR_EGYPTIAN = {
  key: 'cod_confirm.ar.egyptian',
  name: 'akeed_cod_verification_direct_eg',
  code: 'ar_EG',
};
const AR_DEFAULT = {
  key: 'cod_confirm.ar.standard',
  name: 'akeed_cod_verification_friendly',
  code: 'ar',
};
const EN_DEFAULT = {
  key: 'cod_confirm.en.friendly',
  name: 'akeed_cod_verification_friendly',
  code: 'en',
};
/** Every status of record 4.2.1 that a template may hold and not be sent. */
const UNSENDABLE = ['PAUSED', 'DISABLED', 'REJECTED'] as const;

const templateApi = new FakeMetaTemplateApi();
const messagesApi = new FakeMetaMessagesApi();
const values: Record<string, unknown> = {
  WA_ACCESS_TOKEN: FAKE_TOKEN,
  whatsappTemplates: parseWhatsappTemplateConfig({
    WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
    WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED: 'true',
    WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
  }),
};
const config = { get: (key: string) => values[key] };
const syncRepository = new WhatsappTemplateSyncRepository(db as never);
const registry = new TemplateRegistryService(
  new WhatsappTemplatesRepository(db as never),
  config as never,
);
const sync = new WhatsappTemplateSyncService(
  syncRepository,
  new MetaTemplateCatalogAdapter(
    templateApi.httpService as never,
    config as never,
  ),
  registry,
  new TemplateAlertService(syncRepository),
  config as never,
);
const billingConfig = standaloneCreditBillingConfigService({
  STANDALONE_CREDIT_BILLING_ENABLED: 'true',
  PAYMOB_MODE: 'test',
  PAYMOB_BASE_URL: 'http://localhost:9000',
  PAYMOB_CALLBACK_URL: 'http://localhost:9000/api/webhooks/payments/paymob',
  PAYMOB_RETURN_URL: 'http://localhost:9000',
  PAYMOB_SECRET_KEY: 'sandbox-secret',
  PAYMOB_PUBLIC_KEY: 'sandbox-public',
  PAYMOB_HMAC_SECRET: 'sandbox-hmac',
  PAYMOB_CARD_INTEGRATION_ID: 'card1',
  PAYMOB_WALLET_INTEGRATION_ID: 'wallet1',
  PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '900',
});
const send = new VerificationSendService(
  new VerificationsRepository(db as never),
  new OrdersRepository(db as never),
  new BillingEntitlementService(
    new IntegrationMonthlyUsageRepository(db as never),
    harness.router,
  ),
  new CreditEligibilityService(harness.credits, billingConfig),
  dispatches,
  new WhatsAppService(
    messagesApi.httpService as never,
    {
      get: (key: string) =>
        ({
          WA_ACCESS_TOKEN: FAKE_MESSAGES_TOKEN,
          WA_PHONE_NUMBER_ID: FAKE_PHONE_NUMBER_ID,
        })[key],
    } as never,
  ),
  registry,
);

type Platform = 'standalone' | 'shopify';

/** A store that chose Egyptian Arabic and sends in one forced language. */
async function order(platformType: Platform, language: 'ar' | 'en' = 'ar') {
  const source = await harness.merchant(5, platformType);
  await db
    .update(tables.integrations)
    .set({
      defaultLanguage: language,
      storeName: 'Gate Store',
      codTemplateArKey: AR_EGYPTIAN.key,
      codTemplateEnKey: EN_DEFAULT.key,
    })
    .where(eq(tables.integrations.id, source.integrationId));
  return harness.verification(source);
}

/** Sets what Meta says about templates, then lets the real sync read it. */
async function metaSays(
  changes: { name: string; code: string; status: string | null }[],
) {
  templateApi.templates = akeedTemplates().filter((template) => {
    const change = changes.find(
      (entry) =>
        entry.name === template.name && entry.code === template.language,
    );
    if (!change) return true;
    if (change.status === null) return false;
    template.status = change.status;
    return true;
  });
  await expect(sync.runSync('scheduled')).resolves.toMatchObject({
    outcome: 'succeeded',
  });
}

/** Every row the money and send paths keep, for one organization. */
async function accounting(orgId: string) {
  const [counts] = await client<
    {
      usage: string | null;
      ledger: number;
      dispatch_rows: number;
      accounts: string | null;
    }[]
  >`
    SELECT
      (SELECT json_agg(u ORDER BY u.id)::text FROM integration_monthly_usage u WHERE u.org_id = ${orgId}) AS usage,
      (SELECT count(*)::int FROM credit_ledger_entries WHERE org_id = ${orgId}) AS ledger,
      (SELECT count(*)::int FROM verification_message_dispatches WHERE org_id = ${orgId}) AS dispatch_rows,
      (SELECT json_agg(a)::text FROM credit_accounts a WHERE a.org_id = ${orgId}) AS accounts`;
  return counts;
}

async function dispatchRows(verificationId: string) {
  return client<
    {
      kind: string;
      state: string;
      template_variant_key: string | null;
      meta_template_name: string | null;
      meta_language_code: string | null;
      template_fallback_reason: string | null;
      template_skipped_key: string | null;
    }[]
  >`
    SELECT kind, state, template_variant_key, meta_template_name,
      meta_language_code, template_fallback_reason, template_skipped_key
    FROM verification_message_dispatches
    WHERE verification_id = ${verificationId} ORDER BY created_at`;
}

/** The templates the `messages` fake was asked to send, as `name/code`. */
function sentTemplates(): string[] {
  return messagesApi.sends.map((entry) => {
    const template = entry.body.template as {
      name: string;
      language: { code: string };
    };
    return `${template.name}/${template.language.code}`;
  });
}

describe('US-08-08 send guardrail, end to end (PostgreSQL)', () => {
  let lines: string[];

  beforeAll(async () => {
    lines = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          lines.push(String(args[0]));
        });
    }
    await harness.setup();
    for (const name of TEMPLATE_MIGRATIONS) {
      await client.begin(async (tx) => {
        for (const statement of readFileSync(
          resolve(__dirname, '../drizzle', name),
          'utf8',
        ).split('--> statement-breakpoint')) {
          if (statement.trim()) await tx.unsafe(statement);
        }
      });
    }
  });

  afterAll(async () => {
    const logged = lines.join('\n');
    jest.restoreAllMocks();
    try {
      // Criterion 6: the fakes' errors echo their tokens; no log line may.
      expect(logged).not.toContain(FAKE_TOKEN);
      expect(logged).not.toContain(FAKE_MESSAGES_TOKEN);
    } finally {
      await harness.teardown();
    }
  });

  beforeEach(async () => {
    messagesApi.sends.length = 0;
    await metaSays([]);
  });

  it.each(['standalone', 'shopify'] as const)(
    'a %s store sends the template it chose while Meta approves it, and takes one usage',
    async (platformType) => {
      const input = await order(platformType);
      const before = await accounting(input.orgId);

      await expect(
        send.sendInitial(input.verificationId),
      ).resolves.toMatchObject({ status: 'sent' });

      expect(sentTemplates()).toEqual([
        `${AR_EGYPTIAN.name}/${AR_EGYPTIAN.code}`,
      ]);
      expect(await dispatchRows(input.verificationId)).toEqual([
        expect.objectContaining({
          kind: 'initial',
          state: 'accepted',
          template_variant_key: 'ar.egyptian',
          meta_template_name: AR_EGYPTIAN.name,
          template_fallback_reason: null,
          template_skipped_key: null,
        }),
      ]);
      // One usage: a credit for the prepaid store, a count for the plan.
      const after = await accounting(input.orgId);
      expect(after.dispatch_rows).toBe(before.dispatch_rows + 1);
      expect([after.usage, after.ledger, after.accounts]).not.toEqual([
        before.usage,
        before.ledger,
        before.accounts,
      ]);
    },
  );

  describe.each(UNSENDABLE)('the chosen template is %s at Meta', (status) => {
    it('is never sent: the language default goes out, and the dispatch records why', async () => {
      await metaSays([{ ...AR_EGYPTIAN, status }]);
      const input = await order('standalone');
      const before = await accounting(input.orgId);

      await expect(
        send.sendInitial(input.verificationId),
      ).resolves.toMatchObject({ status: 'sent' });

      expect(sentTemplates()).toEqual([
        `${AR_DEFAULT.name}/${AR_DEFAULT.code}`,
      ]);
      expect(await dispatchRows(input.verificationId)).toEqual([
        expect.objectContaining({
          state: 'accepted',
          template_variant_key: 'ar.standard',
          meta_template_name: AR_DEFAULT.name,
          meta_language_code: AR_DEFAULT.code,
          template_fallback_reason: 'not_approved',
          template_skipped_key: AR_EGYPTIAN.key,
        }),
      ]);
      // A fallback is a real send: it takes its one credit like any other.
      const after = await accounting(input.orgId);
      expect(after.dispatch_rows).toBe(before.dispatch_rows + 1);
      expect(after.accounts).not.toEqual(before.accounts);
    });

    it.each(['standalone', 'shopify'] as const)(
      'with the default %s too, a %s send is skipped with template_unavailable: nothing is sent and no usage is reserved',
      async (platformType) => {
        await metaSays([
          { ...AR_EGYPTIAN, status },
          { ...AR_DEFAULT, status },
        ]);
        const input = await order(platformType);
        const before = await accounting(input.orgId);

        await expect(send.sendInitial(input.verificationId)).resolves.toEqual({
          status: 'skipped',
          reason: 'template_unavailable',
        });

        expect(messagesApi.sends).toHaveLength(0);
        expect(await dispatchRows(input.verificationId)).toEqual([]);
        expect(await accounting(input.orgId)).toEqual(before);
        expect(
          lines.some(
            (line) =>
              line.includes('"reason":"template_unavailable"') &&
              line.includes(input.verificationId),
          ),
        ).toBe(true);
      },
    );
  });

  it('a template Meta no longer lists is marked missing and never sent; the default stands in', async () => {
    await metaSays([{ ...AR_EGYPTIAN, status: null }]);
    const input = await order('standalone');

    await expect(send.sendInitial(input.verificationId)).resolves.toMatchObject(
      {
        status: 'sent',
      },
    );

    expect(sentTemplates()).toEqual([`${AR_DEFAULT.name}/${AR_DEFAULT.code}`]);
    expect(await dispatchRows(input.verificationId)).toEqual([
      expect.objectContaining({
        template_fallback_reason: 'not_approved',
        template_skipped_key: AR_EGYPTIAN.key,
      }),
    ]);
  });

  it('a template switched off in Akeed is never sent although Meta approves it', async () => {
    await client`UPDATE whatsapp_templates SET is_active = false WHERE "key" = ${AR_EGYPTIAN.key}`;
    registry.invalidate();
    try {
      const input = await order('standalone');

      await expect(
        send.sendInitial(input.verificationId),
      ).resolves.toMatchObject({ status: 'sent' });

      expect(sentTemplates()).toEqual([
        `${AR_DEFAULT.name}/${AR_DEFAULT.code}`,
      ]);
      expect(await dispatchRows(input.verificationId)).toEqual([
        expect.objectContaining({
          template_fallback_reason: 'key_inactive',
          template_skipped_key: AR_EGYPTIAN.key,
        }),
      ]);
    } finally {
      await client`UPDATE whatsapp_templates SET is_active = true WHERE "key" = ${AR_EGYPTIAN.key}`;
      registry.invalidate();
    }
  });

  it('never crosses language: with every Arabic template paused and English approved, an Arabic send is skipped', async () => {
    await metaSays(
      akeedTemplates()
        .filter((template) => template.language.startsWith('ar'))
        .map((template) => ({
          name: template.name,
          code: template.language,
          status: 'PAUSED',
        })),
    );
    const arabic = await order('standalone', 'ar');
    const english = await order('standalone', 'en');
    const before = await accounting(arabic.orgId);

    await expect(send.sendInitial(arabic.verificationId)).resolves.toEqual({
      status: 'skipped',
      reason: 'template_unavailable',
    });
    await expect(
      send.sendInitial(english.verificationId),
    ).resolves.toMatchObject({ status: 'sent' });

    expect(sentTemplates()).toEqual([`${EN_DEFAULT.name}/${EN_DEFAULT.code}`]);
    expect(await accounting(arabic.orgId)).toEqual(before);
  });

  it('re-reads the registry for the reminder: a template paused after the first send is not sent again, and a skipped reminder takes no usage', async () => {
    const fallsBack = await order('standalone');
    const skips = await order('standalone');
    await send.sendInitial(fallsBack.verificationId);
    await send.sendInitial(skips.verificationId);
    expect(sentTemplates()).toEqual([
      `${AR_EGYPTIAN.name}/${AR_EGYPTIAN.code}`,
      `${AR_EGYPTIAN.name}/${AR_EGYPTIAN.code}`,
    ]);
    messagesApi.sends.length = 0;

    await metaSays([{ ...AR_EGYPTIAN, status: 'PAUSED' }]);
    await expect(
      send.sendFollowUp(fallsBack.verificationId),
    ).resolves.toMatchObject({ status: 'sent' });
    expect(sentTemplates()).toEqual([`${AR_DEFAULT.name}/${AR_DEFAULT.code}`]);
    expect(await dispatchRows(fallsBack.verificationId)).toEqual([
      expect.objectContaining({
        kind: 'initial',
        template_fallback_reason: null,
      }),
      expect.objectContaining({
        kind: 'follow_up',
        template_fallback_reason: 'not_approved',
        template_skipped_key: AR_EGYPTIAN.key,
      }),
    ]);

    await metaSays([
      { ...AR_EGYPTIAN, status: 'PAUSED' },
      { ...AR_DEFAULT, status: 'DISABLED' },
    ]);
    messagesApi.sends.length = 0;
    const before = await accounting(skips.orgId);
    await expect(send.sendFollowUp(skips.verificationId)).resolves.toEqual({
      status: 'skipped',
      reason: 'template_unavailable',
    });
    expect(messagesApi.sends).toHaveLength(0);
    expect(await accounting(skips.orgId)).toEqual(before);
    expect(await dispatchRows(skips.verificationId)).toHaveLength(1);
  });

  it('sends the chosen template again once Meta approves it again', async () => {
    await metaSays([{ ...AR_EGYPTIAN, status: 'PAUSED' }]);
    await metaSays([]);
    const input = await order('standalone');

    await send.sendInitial(input.verificationId);

    expect(sentTemplates()).toEqual([
      `${AR_EGYPTIAN.name}/${AR_EGYPTIAN.code}`,
    ]);
    expect(await dispatchRows(input.verificationId)).toEqual([
      expect.objectContaining({ template_fallback_reason: null }),
    ]);
  });

  it('with the guardrail switched off, sends as before whatever Meta says', async () => {
    await metaSays([{ ...AR_EGYPTIAN, status: 'PAUSED' }]);
    const guarded = values.whatsappTemplates;
    values.whatsappTemplates = parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
      WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
    });
    try {
      const input = await order('standalone');

      await send.sendInitial(input.verificationId);

      expect(sentTemplates()).toEqual([
        `${AR_EGYPTIAN.name}/${AR_EGYPTIAN.code}`,
      ]);
    } finally {
      values.whatsappTemplates = guarded;
    }
  });
});
