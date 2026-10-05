import type { INestApplication } from '@nestjs/common';
import type { Job } from 'bullmq';
import { plainToInstance } from 'class-transformer';
import { validateOrReject } from 'class-validator';
import { asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IntegrationApiKeysRepository } from '../src/infrastructure/database/repositories/integration-api-keys.repository';
import { IntegrationMonthlyUsageRepository } from '../src/infrastructure/database/repositories/integration-monthly-usage.repository';
import { PeriodicPlanAccounting } from '../src/infrastructure/database/repositories/periodic-plan-accounting';
import { PrepaidCreditAccounting } from '../src/infrastructure/database/repositories/prepaid-credit-accounting';
import { UsageAccountingRouter } from '../src/infrastructure/database/repositories/usage-accounting.router';
import { recordedDispatchTemplate } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import {
  integrations,
  orders,
  organizations,
  verificationMessageDispatches,
  verifications,
} from '../src/infrastructure/database/schema';
import { AdminQueryRepository } from '../src/modules/admin/admin-query.repository';
import { AdminTemplateMetricsService } from '../src/modules/admin/admin-template-metrics.service';
import { MessageDispatchResolutionService } from '../src/modules/admin/message-dispatch-resolution.service';
import { IntegrationKeysService } from '../src/modules/integration-keys/integration-keys.service';
import { IMPORT_FIELDS } from '../src/modules/order-imports/mapping/alias-dictionary';
import { CreateManualOrderDto } from '../src/modules/orders/dto/create-manual-order.dto';
import { BillingEntitlementService } from '../src/modules/verification-core/billing-entitlement.service';
import { CreditEligibilityService } from '../src/modules/verification-core/credit-eligibility.service';
import { VerificationSendService } from '../src/modules/verification-core/verification-send.service';
import { SYNTHETIC_TEST_ORDER_ID_PREFIX } from '../src/shared/commerce/synthetic-order';
import {
  toSentTemplateIdentity,
  type SentTemplateIdentity,
} from '../src/shared/messaging/cod-template-selector';
import type { MessagingPort } from '../src/shared/ports/messaging.port';
import {
  createOrderApiApp,
  migrateIntegrationApiKeys,
  postOrder,
} from './contracts/order-api-app';
import {
  releaseGateHarness,
  type ReleaseGateHarness,
} from './contracts/release-gate-harness';
import { seededTemplateRegistry } from '../src/shared/messaging/testing/seeded-template-registry';

/**
 * US-08-02 against real PostgreSQL: every send leaves the template it carried
 * on the dispatch ledger and on the verification, an outcome that is not an
 * acceptance keeps it, migration 0053 leaves an existing ledger readable, and
 * the staff metrics count sends and outcomes per template.
 *
 * Real repositories, ingestion, hub, send service and credit ledger over the
 * release-gate harness. Only the messaging port and the queues are fakes.
 */
const gate = releaseGateHarness();
/** Its own schema, so the migration case can take the columns away. */
const legacy = releaseGateHarness();
type Merchant = Awaited<ReturnType<ReleaseGateHarness['merchant']>>;
type DispatchRow = typeof verificationMessageDispatches.$inferSelect;

const keys = new IntegrationApiKeysRepository(gate.db);
const keyService = new IntegrationKeysService(keys, gate.services.ingestion);

const EG_PHONE = '+201055500002';

/** A store that sends Egyptian Arabic to Arabic numbers and professional English otherwise. */
const STORE_SETTINGS = {
  defaultLanguage: 'auto',
  codTemplateArVariant: 'egyptian',
  codTemplateEnVariant: 'professional',
} as const;

const AR_EGYPTIAN = {
  templateVariantKey: 'ar.egyptian',
  metaTemplateName: 'akeed_cod_verification_direct_eg',
  metaLanguageCode: 'ar_EG',
  resolvedLanguage: 'ar',
  templateName: 'akeed_cod_verification_direct_eg',
  languageCode: 'ar_EG',
};
const AR_GULF = {
  templateVariantKey: 'ar.gulf',
  metaTemplateName: 'akeed_cod_verification_direct_gulf',
  metaLanguageCode: 'ar',
  resolvedLanguage: 'ar',
  templateName: 'akeed_cod_verification_direct_gulf',
  languageCode: 'ar',
};
const EN_PROFESSIONAL = {
  templateVariantKey: 'en.professional',
  metaTemplateName: '_akeed_cod_verification_professional',
  metaLanguageCode: 'en',
  resolvedLanguage: 'en',
  templateName: '_akeed_cod_verification_professional',
  languageCode: 'en',
};

// The send service as the harness wires it, with a messaging port of the
// case's choosing: one that reports what it sent, or one that fails.
const router = new UsageAccountingRouter(
  new PrepaidCreditAccounting(gate.repositories.credits),
  new PeriodicPlanAccounting(),
  gate.config,
);
const billing = new BillingEntitlementService(
  new IntegrationMonthlyUsageRepository(gate.db),
  router,
);
const creditEligibility = new CreditEligibilityService(
  gate.repositories.credits,
  gate.config,
);
function senderWith(messaging: MessagingPort) {
  return new VerificationSendService(
    gate.repositories.verifications,
    gate.repositories.orders,
    billing,
    creditEligibility,
    gate.repositories.dispatches,
    messaging,
    seededTemplateRegistry(),
  );
}

/** Answers as the Meta adapter does: a message id and what it sent. */
function reportingPort(
  reported: Partial<SentTemplateIdentity> = {},
): MessagingPort {
  return {
    sendVerificationTemplate: (params) =>
      Promise.resolve({
        messages: [{ id: `wamid-e08-${randomUUID()}` }],
        template: { ...toSentTemplateIdentity(params.template), ...reported },
      }),
  };
}

const failingPort: MessagingPort = {
  sendVerificationTemplate: () =>
    Promise.reject(new Error('synthetic provider timeout')),
};

async function dispatchesOf(
  harness: ReleaseGateHarness,
  verificationId: string,
) {
  return harness.db
    .select()
    .from(verificationMessageDispatches)
    .where(eq(verificationMessageDispatches.verificationId, verificationId))
    .orderBy(
      asc(verificationMessageDispatches.kind),
      asc(verificationMessageDispatches.generation),
    );
}

async function verificationOfOrder(
  harness: ReleaseGateHarness,
  orderId: string,
) {
  const [row] = await harness.db
    .select()
    .from(verifications)
    .where(eq(verifications.orderId, orderId));
  return row;
}

async function verificationById(id: string) {
  const [row] = await gate.db
    .select()
    .from(verifications)
    .where(eq(verifications.id, id));
  return row;
}

function templateOf(row: DispatchRow) {
  return {
    templateVariantKey: row.templateVariantKey,
    metaTemplateName: row.metaTemplateName,
    metaLanguageCode: row.metaLanguageCode,
    resolvedLanguage: row.resolvedLanguage,
    templateName: row.templateName,
    languageCode: row.languageCode,
  };
}

async function manualOrder(
  harness: ReleaseGateHarness,
  merchant: Merchant,
  reference: string,
) {
  const body = plainToInstance(CreateManualOrderDto, {
    customerPhone: EG_PHONE,
    customerName: 'Template Customer',
    orderNumber: reference,
    totalPrice: '310.00',
    currency: 'EGP',
    paymentMethod: 'cash_on_delivery',
  });
  await validateOrReject(body);
  const created = await harness.services.orders.createManualOrder(
    merchant.user,
    `template-${randomUUID()}`,
    body,
  );
  await harness.drain();
  return created.orderId;
}

/** Upload, map, commit, start and release: the merchant's whole import. */
async function importedOrder(merchant: Merchant, reference: string) {
  const bytes = Buffer.from(
    [
      'Order Number,Customer Name,Phone,Amount,Payment Method',
      `${reference},Template Customer,${EG_PHONE},310.00,cash_on_delivery`,
    ].join('\r\n'),
  );
  const { batchId } = await gate.services.uploads.upload(
    merchant.user,
    merchant.source,
    {
      buffer: bytes,
      size: bytes.length,
      originalname: `template-${randomUUID()}.csv`,
    },
  );
  const columns: Record<string, unknown> = {
    orderReference: 'Order Number',
    customerName: ['Customer Name'],
    phone: 'Phone',
    amount: 'Amount',
    paymentMethod: 'Payment Method',
  };
  await gate.services.mapping.save(merchant.user, merchant.source, batchId, {
    mapping: Object.fromEntries(
      IMPORT_FIELDS.map((field) => [field, columns[field] ?? null]),
    ),
    options: {
      country: 'EG',
      defaultCurrency: 'EGP',
      dateFormat: 'auto',
      paymentValueMap: {},
    },
  } as never);
  await gate.services.commits.commit(
    merchant.user,
    merchant.source,
    batchId,
    `commit-${batchId}`,
  );
  for (const job of gate.commitJobs.splice(0))
    await gate.services.commitProcessor.process({ data: job } as Job<{
      batchId: string;
      orgId: string;
    }>);
  const quote = await gate.services.starts.quote(
    merchant.user,
    merchant.source,
    batchId,
  );
  await gate.services.starts.start(
    merchant.user,
    merchant.source,
    batchId,
    `start-${batchId}`,
    { quoteToken: quote.quoteToken },
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    await gate.services.ticks.tick(merchant.orgId);
    await gate.drain();
    const [batch] = await gate.client<{ status: string }[]>`
      SELECT status FROM order_import_batches WHERE id = ${batchId}`;
    if (batch.status !== 'releasing') break;
  }
  const [row] = await gate.client<{ order_id: string }[]>`
    SELECT order_id FROM order_import_rows
    WHERE batch_id = ${batchId} AND order_id IS NOT NULL`;
  return row.order_id;
}

/** An order and its verification, stored but not sent. */
async function unsentVerification(
  store: { orgId: string; integrationId: string },
  order: Partial<typeof orders.$inferInsert> = {},
) {
  const [storedOrder] = await gate.db
    .insert(orders)
    .values({
      orgId: store.orgId,
      integrationId: store.integrationId,
      externalOrderId: `E08-${randomUUID()}`,
      orderNumber: '7001',
      customerPhone: EG_PHONE,
      customerName: 'Template Customer',
      totalPrice: '310.00',
      currency: 'EGP',
      paymentMethod: 'cod',
      ...order,
    })
    .returning();
  const [verification] = await gate.db
    .insert(verifications)
    .values({ orgId: store.orgId, orderId: storedOrder.id })
    .returning();
  return { order: storedOrder, verification };
}

describe('US-08-02 template identity PostgreSQL contract', () => {
  let app: INestApplication | undefined;

  beforeAll(async () => {
    // Each harness installs uuid-ossp into its own schema if nobody has. With
    // two schemas the second would not see the first one's copy, so it goes
    // into `public`, which both search paths end with.
    await gate.client.unsafe(
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public',
    );
    await gate.setup();
    await migrateIntegrationApiKeys(gate);
    await legacy.setup();
    app = await createOrderApiApp({ keys, ingestion: gate.services.ingestion });
  });
  afterAll(async () => {
    // Every connection is closed even when setup failed part-way.
    try {
      await app?.close();
    } finally {
      try {
        await legacy.teardown();
      } finally {
        await gate.teardown();
      }
    }
  });

  describe('every send path records the template it carried', () => {
    async function viaApi(merchant: Merchant, reference: string) {
      const issued = await keyService.create(merchant.user, { name: 'E08' });
      const response = await postOrder(
        app!,
        issued.secret,
        `order-${randomUUID()}`,
        {
          externalOrderId: reference,
          customerName: 'Template Customer',
          customerPhone: EG_PHONE,
          totalPrice: '310.00',
          currency: 'EGP',
          paymentMethod: 'cash_on_delivery',
        },
      );
      expect(response.status).toBe(202);
      await gate.drain();
      return (response.body as { orderId: string }).orderId;
    }

    const CHANNELS: [
      string,
      (merchant: Merchant, reference: string) => Promise<string>,
    ][] = [
      [
        'a manual order',
        (merchant, reference) => manualOrder(gate, merchant, reference),
      ],
      ['a bulk import release', importedOrder],
      ['an API order', viaApi],
    ];

    it.each(CHANNELS)('for %s', async (_label, submit) => {
      const merchant = await gate.merchant({ settings: STORE_SETTINGS });

      const orderId = await submit(merchant, `T-${randomUUID().slice(0, 8)}`);

      const verification = await verificationOfOrder(gate, orderId);
      const rows = await dispatchesOf(gate, verification.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'initial',
        state: 'accepted',
        templatePurpose: 'initial',
        ...AR_EGYPTIAN,
      });
      // The verification mirrors the message its wa_message_id points at.
      expect(verification).toMatchObject({
        status: 'sent',
        waMessageId: rows[0].providerMessageId,
        templateName: AR_EGYPTIAN.metaTemplateName,
        languageCode: AR_EGYPTIAN.metaLanguageCode,
      });
    });

    it('for the reminder, which becomes the latest accepted send', async () => {
      const merchant = await gate.merchant({ settings: STORE_SETTINGS });
      const orderId = await manualOrder(gate, merchant, 'T-REMINDER');
      const verification = await verificationOfOrder(gate, orderId);
      // The merchant picks another style before the reminder is due.
      await gate.db
        .update(integrations)
        .set({ codTemplateArVariant: 'gulf' })
        .where(eq(integrations.id, merchant.integrationId));

      const job = gate.automationJobs.find(
        (candidate) =>
          candidate.verificationId === verification.id &&
          candidate.kind === 'follow_up',
      );
      expect(job).toBeDefined();
      await gate.runAutomation(job!);

      const rows = await dispatchesOf(gate, verification.id);
      expect(
        rows.map((row) => ({
          kind: row.kind,
          state: row.state,
          purpose: row.templatePurpose,
          ...templateOf(row),
        })),
      ).toEqual([
        {
          kind: 'initial',
          state: 'accepted',
          purpose: 'initial',
          ...AR_EGYPTIAN,
        },
        {
          kind: 'follow_up',
          state: 'accepted',
          purpose: 'reminder',
          ...AR_GULF,
        },
      ]);
      expect(await verificationById(verification.id)).toMatchObject({
        waMessageId: rows[1].providerMessageId,
        templateName: AR_GULF.metaTemplateName,
        languageCode: AR_GULF.metaLanguageCode,
      });
    });

    it('with the language the send resolved to, not the store preference', async () => {
      const merchant = await gate.merchant({
        settings: { ...STORE_SETTINGS, defaultLanguage: 'en' },
      });

      const orderId = await manualOrder(gate, merchant, 'T-FORCED-EN');

      const verification = await verificationOfOrder(gate, orderId);
      const [row] = await dispatchesOf(gate, verification.id);
      expect(row).toMatchObject({
        templatePurpose: 'initial',
        ...EN_PROFESSIONAL,
      });
      expect(verification).toMatchObject({
        templateName: EN_PROFESSIONAL.metaTemplateName,
        languageCode: 'en',
      });
    });

    it('for the onboarding test, as a free test send', async () => {
      const merchant = await gate.merchant({ settings: STORE_SETTINGS });
      const [integration] = await gate.db
        .select()
        .from(integrations)
        .where(eq(integrations.id, merchant.integrationId));
      const before = await gate.repositories.credits.getSummary(merchant.orgId);

      const result = await gate.services.hub.handleSyntheticTestOrder(
        {
          orgId: merchant.orgId,
          integrationId: merchant.integrationId,
          externalOrderId: `${SYNTHETIC_TEST_ORDER_ID_PREFIX}${randomUUID()}`,
          orderNumber: 'TEST-1',
          customerPhone: EG_PHONE,
          customerName: 'أحمد',
          totalPrice: '250.00',
          currency: 'EGP',
          paymentMethod: 'cod',
          rawPayload: {
            source: 'onboarding_test',
            synthetic: true,
            externalCommerceActionAllowed: false,
            createdAt: new Date().toISOString(),
          },
        },
        integration,
        'onboarding',
      );

      expect(result).toMatchObject({ deliveryStatus: 'sent' });
      if (!('verificationId' in result)) throw new Error('test was skipped');
      const [row] = await dispatchesOf(gate, result.verificationId);
      expect(row).toMatchObject({
        kind: 'initial',
        state: 'accepted',
        templatePurpose: 'test',
        metadata: { billingExempt: true },
        ...AR_EGYPTIAN,
      });
      expect(await verificationById(result.verificationId)).toMatchObject({
        templateName: AR_EGYPTIAN.metaTemplateName,
        languageCode: AR_EGYPTIAN.metaLanguageCode,
      });
      // The test is free: the claim held no credit.
      const after = await gate.repositories.credits.getSummary(merchant.orgId);
      expect(after).toMatchObject({
        postedBalance: before?.postedBalance,
        heldCredits: before?.heldCredits,
      });
    });

    it.each(['shopify', 'easyorders', 'woocommerce'] as const)(
      'for a plan-billed %s store, first send and reminder',
      async (platformType) => {
        const orgId = randomUUID();
        await gate.db.insert(organizations).values({
          id: orgId,
          name: `Plan store ${platformType}`,
          slug: orgId,
        });
        const [integration] = await gate.db
          .insert(integrations)
          .values({
            orgId,
            platformType,
            platformStoreUrl: `${platformType}-${orgId}.example.test`,
            storeName: 'Plan Store',
            isActive: true,
            onboardingStatus: 'completed',
            billingStatus:
              platformType === 'shopify' ? 'active' : 'not_required',
            billingPlanId: 'basic',
            billingActivatedAt: new Date().toISOString(),
            defaultLanguage: 'ar',
            codTemplateArVariant: 'gulf',
            codTemplateEnVariant: 'direct',
          })
          .returning();
        const { verification } = await unsentVerification({
          orgId,
          integrationId: integration.id,
        });
        expect(verification).toMatchObject({
          templateName: null,
          languageCode: null,
        });
        const sender = senderWith(reportingPort());

        await expect(
          sender.sendInitial(verification.id),
        ).resolves.toMatchObject({ status: 'sent' });
        await expect(
          sender.sendFollowUp(verification.id),
        ).resolves.toMatchObject({ status: 'sent' });

        const rows = await dispatchesOf(gate, verification.id);
        expect(
          rows.map((row) => ({
            kind: row.kind,
            state: row.state,
            accountingMode: row.accountingMode,
            purpose: row.templatePurpose,
            ...templateOf(row),
          })),
        ).toEqual([
          {
            kind: 'initial',
            state: 'accepted',
            accountingMode: 'periodic_plan',
            purpose: 'initial',
            ...AR_GULF,
          },
          {
            kind: 'follow_up',
            state: 'accepted',
            accountingMode: 'periodic_plan',
            purpose: 'reminder',
            ...AR_GULF,
          },
        ]);
        expect(await verificationById(verification.id)).toMatchObject({
          templateName: AR_GULF.metaTemplateName,
          languageCode: AR_GULF.metaLanguageCode,
        });
      },
    );

    it('with what the adapter reports it sent, in the acceptance itself', async () => {
      const merchant = await gate.merchant({ settings: STORE_SETTINGS });
      const { verification } = await unsentVerification(merchant);
      // An adapter that sent the Arabic default instead of what was selected.
      const sender = senderWith(
        reportingPort({
          variantKey: 'ar.standard',
          templateName: 'akeed_cod_verification_friendly',
          languageCode: 'ar',
        }),
      );

      await sender.sendInitial(verification.id);

      const [row] = await dispatchesOf(gate, verification.id);
      expect(row).toMatchObject({
        state: 'accepted',
        // The purpose is a fact about the claim and is left as claimed.
        templatePurpose: 'initial',
        templateVariantKey: 'ar.standard',
        metaTemplateName: 'akeed_cod_verification_friendly',
        metaLanguageCode: 'ar',
        resolvedLanguage: 'ar',
        templateName: 'akeed_cod_verification_friendly',
        languageCode: 'ar',
      });
      expect(await verificationById(verification.id)).toMatchObject({
        templateName: 'akeed_cod_verification_friendly',
        languageCode: 'ar',
      });
    });
  });

  describe('an outcome that is not an acceptance keeps the identity', () => {
    it('through an unknown outcome and its staff resolution', async () => {
      const merchant = await gate.merchant({ settings: STORE_SETTINGS });
      const { verification } = await unsentVerification(merchant);

      await expect(
        senderWith(failingPort).sendInitial(verification.id),
      ).resolves.toMatchObject({ status: 'outcome_unknown' });

      const [unknown] = await dispatchesOf(gate, verification.id);
      expect(unknown).toMatchObject({
        state: 'outcome_unknown',
        providerMessageId: null,
        acceptedAt: null,
        templatePurpose: 'initial',
        ...AR_EGYPTIAN,
      });
      // Nothing was accepted, so the verification names no template yet.
      expect(await verificationById(verification.id)).toMatchObject({
        status: 'failed',
        templateName: null,
        languageCode: null,
      });

      // Staff find the message at the provider and resolve the dispatch. No
      // adapter result exists: the identity comes from the row itself.
      const resolution = new MessageDispatchResolutionService(
        gate.repositories.dispatches,
        gate.repositories.events,
        gate.services.dispatcher,
        gate.services.hub,
      );
      await resolution.resolve(randomUUID(), unknown.id, {
        resolution: 'accepted',
        providerMessageId: `wamid-staff-${randomUUID()}`,
        reason: 'Found delivered in the provider console',
      });

      const [resolved] = await dispatchesOf(gate, verification.id);
      expect(resolved).toMatchObject({
        state: 'accepted',
        templatePurpose: 'initial',
        ...AR_EGYPTIAN,
      });
      expect(await verificationById(verification.id)).toMatchObject({
        status: 'sent',
        waMessageId: resolved.providerMessageId,
        templateName: AR_EGYPTIAN.metaTemplateName,
        languageCode: AR_EGYPTIAN.metaLanguageCode,
      });
    });

    it('through a rejection the provider confirmed', async () => {
      const merchant = await gate.merchant({ settings: STORE_SETTINGS });
      gate.provider.rejecting = true;
      let orderId: string;
      try {
        orderId = await manualOrder(gate, merchant, 'T-REJECTED');
      } finally {
        gate.provider.rejecting = false;
      }

      const verification = await verificationOfOrder(gate, orderId);
      const [row] = await dispatchesOf(gate, verification.id);
      expect(row).toMatchObject({
        state: 'rejected',
        templatePurpose: 'initial',
        ...AR_EGYPTIAN,
      });
      expect(verification).toMatchObject({
        status: 'failed',
        templateName: null,
        languageCode: null,
      });
    });
  });

  describe('migration 0053 over an existing ledger', () => {
    const migration = readFileSync(
      resolve(__dirname, '../drizzle/0053_dispatch_template_identity.sql'),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((statement) => statement.trim());

    /** The rollback the migration header describes. */
    const ROLLBACK = `
      DROP INDEX IF EXISTS "idx_verification_message_dispatches_accepted_at";
      ALTER TABLE "verification_message_dispatches"
        DROP CONSTRAINT IF EXISTS "dispatch_template_purpose_check",
        DROP CONSTRAINT IF EXISTS "dispatch_resolved_language_check",
        DROP COLUMN "template_variant_key",
        DROP COLUMN "template_purpose",
        DROP COLUMN "meta_template_name",
        DROP COLUMN "meta_language_code",
        DROP COLUMN "resolved_language";
      ALTER TABLE "verifications"
        ALTER COLUMN "template_name" SET DEFAULT 'cod_verification',
        ALTER COLUMN "language_code" SET DEFAULT 'ar';
    `;

    const oldColumns = () => legacy.client<Record<string, unknown>[]>`
      SELECT id, kind::text AS kind, state::text AS state, template_name,
        language_code, provider_message_id, accepted_at, dispatch_key
      FROM verification_message_dispatches ORDER BY id`;

    it('rolls back and reapplies without losing or rewriting a row', async () => {
      const merchant = await legacy.merchant({ settings: STORE_SETTINGS });
      const orderId = await manualOrder(legacy, merchant, 'T-LEGACY');
      const verification = await verificationOfOrder(legacy, orderId);
      const beforeRollback = await oldColumns();
      expect(beforeRollback).toHaveLength(1);

      // Back to the ledger as it was before this story: no identity columns,
      // and rows that say only what the old code wrote.
      await legacy.client.unsafe(ROLLBACK);
      expect(await oldColumns()).toEqual(beforeRollback);
      await legacy.client`
        UPDATE verification_message_dispatches
        SET template_name = 'cod_verification', language_code = 'auto'`;
      await legacy.client`
        UPDATE verifications
        SET template_name = 'cod_verification', language_code = 'ar'`;
      await legacy.client`
        INSERT INTO verification_message_dispatches
          (org_id, integration_id, verification_id, dispatch_key, kind, state,
           template_name, language_code)
        VALUES (${merchant.orgId}, ${merchant.integrationId},
          ${verification.id}, ${`${verification.id}:legacy:1`},
          'legacy_unknown', 'accepted', 'cod_verification', 'ar')`;
      const existing = await oldColumns();
      expect(existing).toHaveLength(2);

      // Applied twice: it must be safe to replay.
      for (let pass = 0; pass < 2; pass++)
        for (const statement of migration)
          await legacy.client.unsafe(statement);

      // Every old row is still there, unchanged, and readable through the
      // repository with nothing recorded for it.
      expect(await oldColumns()).toEqual(existing);
      for (const { id } of existing) {
        const row = await legacy.repositories.dispatches.findById(String(id));
        expect(row).toMatchObject({
          templateVariantKey: null,
          templatePurpose: null,
          metaTemplateName: null,
          metaLanguageCode: null,
          resolvedLanguage: null,
        });
        expect(recordedDispatchTemplate(row!)).toBeUndefined();
      }
      expect(await verificationOfOrder(legacy, orderId)).toMatchObject({
        templateName: 'cod_verification',
        languageCode: 'ar',
      });

      // The misleading defaults are gone for rows created from now on.
      const defaults = await legacy.client<{ column_default: string | null }[]>`
        SELECT column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'verifications'
          AND column_name IN ('template_name', 'language_code')`;
      expect(defaults).toHaveLength(2);
      expect(defaults.every((row) => row.column_default === null)).toBe(true);

      // A send after the migration records its template next to the old rows.
      const nextOrderId = await manualOrder(legacy, merchant, 'T-AFTER-0053');
      const next = await verificationOfOrder(legacy, nextOrderId);
      const [sent] = await dispatchesOf(legacy, next.id);
      expect(sent).toMatchObject({
        templatePurpose: 'initial',
        ...AR_EGYPTIAN,
      });
    });
  });

  describe('template metrics', () => {
    const metrics = new AdminQueryRepository(gate.db);
    const MARCH = {
      from: '2026-03-01T00:00:00.000Z',
      toExclusive: '2026-04-01T00:00:00.000Z',
    };

    interface SeedDispatch {
      kind: 'initial' | 'follow_up';
      acceptedAt: string;
      delivered?: boolean;
      read?: boolean;
      identity?: {
        variantKey: string;
        templateName: string;
        languageCode: string;
        language: 'ar' | 'en';
        purpose: 'initial' | 'reminder' | 'test';
      };
    }

    const EGYPTIAN = {
      variantKey: 'ar.egyptian',
      templateName: 'akeed_cod_verification_direct_eg',
      languageCode: 'ar_EG',
      language: 'ar' as const,
    };
    const GULF = {
      variantKey: 'ar.gulf',
      templateName: 'akeed_cod_verification_direct_gulf',
      languageCode: 'ar',
      language: 'ar' as const,
    };
    const STANDARD = {
      variantKey: 'ar.standard',
      templateName: 'akeed_cod_verification_friendly',
      languageCode: 'ar',
      language: 'ar' as const,
    };
    const FRIENDLY = {
      variantKey: 'en.friendly',
      templateName: 'akeed_cod_verification_friendly',
      languageCode: 'en',
      language: 'en' as const,
    };
    const PROFESSIONAL = {
      variantKey: 'en.professional',
      templateName: '_akeed_cod_verification_professional',
      languageCode: 'en',
      language: 'en' as const,
    };
    const DIRECT = {
      variantKey: 'en.direct',
      templateName: 'akeed_cod_verification_direct_',
      languageCode: 'en',
      language: 'en' as const,
    };

    /** One verification with the sends it had and how it ended. */
    async function seed(
      store: Merchant,
      scenario: {
        isTest?: boolean;
        outcome?: Partial<typeof verifications.$inferInsert>;
        dispatches: SeedDispatch[];
      },
    ) {
      const { verification } = await unsentVerification(store, {
        isTest: scenario.isTest ?? false,
      });
      if (scenario.outcome)
        await gate.db
          .update(verifications)
          .set(scenario.outcome)
          .where(eq(verifications.id, verification.id));
      for (const dispatch of scenario.dispatches) {
        await gate.db.insert(verificationMessageDispatches).values({
          orgId: store.orgId,
          integrationId: store.integrationId,
          verificationId: verification.id,
          dispatchKey: `${verification.id}:${dispatch.kind}:1`,
          kind: dispatch.kind,
          state: 'accepted',
          providerMessageId: `wamid-metrics-${randomUUID()}`,
          acceptedAt: dispatch.acceptedAt,
          deliveredAt: dispatch.delivered ? dispatch.acceptedAt : null,
          readAt: dispatch.read ? dispatch.acceptedAt : null,
          // A row from before identity was recorded holds the old
          // placeholders and nothing else.
          templateName: dispatch.identity?.templateName ?? 'cod_verification',
          languageCode: dispatch.identity?.languageCode ?? 'auto',
          templateVariantKey: dispatch.identity?.variantKey ?? null,
          templatePurpose: dispatch.identity?.purpose ?? null,
          metaTemplateName: dispatch.identity?.templateName ?? null,
          metaLanguageCode: dispatch.identity?.languageCode ?? null,
          resolvedLanguage: dispatch.identity?.language ?? null,
        });
      }
      return verification.id;
    }

    const customerConfirmed = (at: string) => ({
      status: 'confirmed' as const,
      confirmedAt: at,
      confirmationSource: 'customer',
    });

    beforeAll(async () => {
      const store = await gate.merchant();
      const otherStore = await gate.merchant();

      // Confirmed after the first message.
      await seed(store, {
        outcome: customerConfirmed('2026-03-02T11:00:00.000Z'),
        dispatches: [
          {
            kind: 'initial',
            acceptedAt: '2026-03-02T10:00:00.000Z',
            delivered: true,
            read: true,
            identity: { ...EGYPTIAN, purpose: 'initial' },
          },
        ],
      });
      // Confirmed after the reminder, same template: one confirmation, not two.
      await seed(store, {
        outcome: customerConfirmed('2026-03-03T13:00:00.000Z'),
        dispatches: [
          {
            kind: 'initial',
            acceptedAt: '2026-03-03T10:00:00.000Z',
            delivered: true,
            identity: { ...EGYPTIAN, purpose: 'initial' },
          },
          {
            kind: 'follow_up',
            acceptedAt: '2026-03-03T12:00:00.000Z',
            delivered: true,
            read: true,
            identity: { ...EGYPTIAN, purpose: 'reminder' },
          },
        ],
      });
      // Canceled after a reminder that used another template: the reminder's
      // template gets the cancellation, the first message's gets none.
      await seed(store, {
        outcome: {
          status: 'canceled',
          canceledAt: '2026-03-04T12:30:00.000Z',
          cancellationSource: 'customer',
        },
        dispatches: [
          {
            kind: 'initial',
            acceptedAt: '2026-03-04T10:00:00.000Z',
            identity: { ...FRIENDLY, purpose: 'initial' },
          },
          {
            kind: 'follow_up',
            acceptedAt: '2026-03-04T12:00:00.000Z',
            identity: { ...PROFESSIONAL, purpose: 'reminder' },
          },
        ],
      });
      // Confirmed before a late reminder was accepted: the first message
      // gets it.
      await seed(store, {
        outcome: customerConfirmed('2026-03-05T10:30:00.000Z'),
        dispatches: [
          {
            kind: 'initial',
            acceptedAt: '2026-03-05T10:00:00.000Z',
            identity: { ...GULF, purpose: 'initial' },
          },
          {
            kind: 'follow_up',
            acceptedAt: '2026-03-05T12:00:00.000Z',
            identity: { ...STANDARD, purpose: 'reminder' },
          },
        ],
      });
      // Ran out to no-reply.
      await seed(store, {
        outcome: { status: 'no_reply', noReplyAt: '2026-03-06T15:00:00.000Z' },
        dispatches: [
          {
            kind: 'initial',
            acceptedAt: '2026-03-06T10:00:00.000Z',
            identity: { ...GULF, purpose: 'initial' },
          },
        ],
      });
      // No reply, then the merchant canceled: still a no-reply, not a
      // customer cancellation.
      await seed(store, {
        outcome: {
          status: 'canceled',
          noReplyAt: '2026-03-07T15:00:00.000Z',
          canceledAt: '2026-03-08T09:00:00.000Z',
          merchantCanceledAt: '2026-03-08T09:00:00.000Z',
          cancellationSource: 'merchant_no_reply',
        },
        dispatches: [
          {
            kind: 'initial',
            acceptedAt: '2026-03-07T10:00:00.000Z',
            identity: { ...GULF, purpose: 'initial' },
          },
        ],
      });
      // Confirmed by the merchant by hand: not a reply to the template.
      await seed(store, {
        outcome: {
          status: 'confirmed',
          confirmedAt: '2026-03-08T12:00:00.000Z',
          confirmationSource: 'merchant_manual',
        },
        dispatches: [
          {
            kind: 'initial',
            acceptedAt: '2026-03-08T10:00:00.000Z',
            identity: { ...GULF, purpose: 'initial' },
          },
        ],
      });
      // Accepted before identity was recorded, and confirmed.
      await seed(store, {
        outcome: customerConfirmed('2026-03-09T11:00:00.000Z'),
        dispatches: [
          {
            kind: 'initial',
            acceptedAt: '2026-03-09T10:00:00.000Z',
            delivered: true,
          },
        ],
      });
      // A merchant's test send, confirmed.
      await seed(store, {
        isTest: true,
        outcome: customerConfirmed('2026-03-10T10:05:00.000Z'),
        dispatches: [
          {
            kind: 'initial',
            acceptedAt: '2026-03-10T10:00:00.000Z',
            identity: { ...EGYPTIAN, purpose: 'test' },
          },
        ],
      });
      // Another store: the numbers are across tenants.
      await seed(otherStore, {
        dispatches: [
          {
            kind: 'initial',
            acceptedAt: '2026-03-11T10:00:00.000Z',
            identity: { ...EGYPTIAN, purpose: 'initial' },
          },
        ],
      });
      // The first and last instants of the range, and the instants either side.
      for (const acceptedAt of [
        '2026-02-28T23:59:59.999Z',
        '2026-03-01T00:00:00.000Z',
        '2026-03-31T23:59:59.999Z',
        '2026-04-01T00:00:00.000Z',
      ])
        await seed(otherStore, {
          dispatches: [
            {
              kind: 'initial',
              acceptedAt,
              identity: { ...DIRECT, purpose: 'initial' },
            },
          ],
        });
    });

    const counts = (row: Record<string, unknown>) => ({
      sends: Number(row.sends),
      initial: Number(row.sends_initial),
      reminder: Number(row.sends_reminder),
      test: Number(row.sends_test),
      delivered: Number(row.delivered),
      read: Number(row.read),
      confirmed: Number(row.confirmed),
      canceled: Number(row.canceled),
      noReply: Number(row.no_reply),
    });

    it('counts sends and credits each outcome to the latest send before it', async () => {
      const rows = await metrics.findTemplateMetrics({
        ...MARCH,
        includeTest: false,
      });

      expect(
        rows.map((row) => ({
          variantKey: row.variant_key,
          templateName: row.template_name,
          languageCode: row.language_code,
          language: row.language,
          ...counts(row),
        })),
      ).toEqual([
        {
          ...EGYPTIAN,
          sends: 4,
          initial: 3,
          reminder: 1,
          test: 0,
          delivered: 3,
          read: 2,
          confirmed: 2,
          canceled: 0,
          noReply: 0,
        },
        {
          ...GULF,
          sends: 4,
          initial: 4,
          reminder: 0,
          test: 0,
          delivered: 0,
          read: 0,
          confirmed: 1,
          canceled: 0,
          noReply: 2,
        },
        {
          ...STANDARD,
          sends: 1,
          initial: 0,
          reminder: 1,
          test: 0,
          delivered: 0,
          read: 0,
          confirmed: 0,
          canceled: 0,
          noReply: 0,
        },
        {
          ...DIRECT,
          sends: 2,
          initial: 2,
          reminder: 0,
          test: 0,
          delivered: 0,
          read: 0,
          confirmed: 0,
          canceled: 0,
          noReply: 0,
        },
        {
          ...FRIENDLY,
          sends: 1,
          initial: 1,
          reminder: 0,
          test: 0,
          delivered: 0,
          read: 0,
          confirmed: 0,
          canceled: 0,
          noReply: 0,
        },
        {
          ...PROFESSIONAL,
          sends: 1,
          initial: 0,
          reminder: 1,
          test: 0,
          delivered: 0,
          read: 0,
          confirmed: 0,
          canceled: 1,
          noReply: 0,
        },
        // Sends without a recorded template: one group, no template named.
        {
          variantKey: null,
          templateName: null,
          languageCode: null,
          language: null,
          sends: 1,
          initial: 0,
          reminder: 0,
          test: 0,
          delivered: 1,
          read: 0,
          confirmed: 1,
          canceled: 0,
          noReply: 0,
        },
      ]);
    });

    it('keeps two languages of one provider template name apart', async () => {
      const rows = await metrics.findTemplateMetrics({
        ...MARCH,
        includeTest: false,
      });

      const friendlyName = rows.filter(
        (row) => row.template_name === 'akeed_cod_verification_friendly',
      );
      expect(
        friendlyName.map((row) => [row.variant_key, row.language_code]),
      ).toEqual([
        ['ar.standard', 'ar'],
        ['en.friendly', 'en'],
      ]);
    });

    it('adds test sends only when asked', async () => {
      const rows = await metrics.findTemplateMetrics({
        ...MARCH,
        includeTest: true,
      });

      const egyptian = rows.find((row) => row.variant_key === 'ar.egyptian');
      expect(counts(egyptian!)).toMatchObject({
        sends: 5,
        initial: 3,
        reminder: 1,
        test: 1,
        confirmed: 3,
      });
    });

    it('splits one template by purpose, adding up to its row (US-08-05)', async () => {
      const filter = { ...MARCH, includeTest: true };
      const [whole] = (await metrics.findTemplateMetrics(filter)).filter(
        (row) => row.variant_key === 'ar.egyptian',
      );
      const byPurpose = await metrics.findTemplateMetricsByPurpose(
        filter,
        'ar.egyptian',
      );

      expect(byPurpose.map((row) => [row.purpose, Number(row.sends)])).toEqual([
        ['initial', 3],
        ['reminder', 1],
        ['test', 1],
      ]);
      for (const column of [
        'sends',
        'delivered',
        'read',
        'confirmed',
        'canceled',
        'no_reply',
      ] as const) {
        expect(
          byPurpose.reduce((sum, row) => sum + Number(row[column]), 0),
        ).toBe(Number(whole[column]));
      }
      const withoutTests = await metrics.findTemplateMetricsByPurpose(
        { ...MARCH, includeTest: false },
        'ar.egyptian',
      );
      expect(withoutTests.map((row) => row.purpose)).toEqual([
        'initial',
        'reminder',
      ]);
      await expect(
        metrics.findTemplateMetricsByPurpose(filter, 'ar.retired'),
      ).resolves.toEqual([]);
    });

    it('answers a range with no sends with no rows', async () => {
      await expect(
        metrics.findTemplateMetrics({
          from: '2025-01-01T00:00:00.000Z',
          toExclusive: '2025-01-03T00:00:00.000Z',
          includeTest: true,
        }),
      ).resolves.toEqual([]);
    });

    it('serves the staff response with unrecorded sends set apart', async () => {
      const response = await new AdminTemplateMetricsService(
        metrics,
      ).getMetrics({ from: '2026-03-01', to: '2026-03-31' });

      expect(response.templates.map((row) => row.variant_key)).toEqual([
        'ar.egyptian',
        'ar.gulf',
        'ar.standard',
        'en.direct',
        'en.friendly',
        'en.professional',
      ]);
      expect(response.templates[0]).toMatchObject({
        variant_key: 'ar.egyptian',
        template_name: 'akeed_cod_verification_direct_eg',
        language: 'ar',
        language_code: 'ar_EG',
        sends: { total: 4, initial: 3, reminder: 1, test: 0 },
        delivered: 3,
        read: 2,
        replies: 2,
        confirmed: 2,
        canceled: 0,
        no_reply: 0,
      });
      expect(response.not_recorded).toEqual({
        sends: { total: 1, initial: 0, reminder: 0, test: 0 },
        delivered: 1,
        read: 0,
        replies: 1,
        confirmed: 1,
        canceled: 0,
        no_reply: 0,
      });
    });
  });
});
