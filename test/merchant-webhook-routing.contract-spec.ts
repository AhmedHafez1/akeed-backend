import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import {
  CustomerMessagesRepository,
  type ReceivingNumber,
} from '../src/infrastructure/database/repositories/customer-messages.repository';
import {
  WhatsappConnectionsRepository,
  WhatsappAccountInUseError,
} from '../src/infrastructure/database/repositories/whatsapp-connections.repository';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import {
  customerMessages,
  verifications,
  whatsappConnections,
  verificationSenderAttempts,
  metaWebhookEvents,
} from '../src/infrastructure/database/schema';
import { ConnectionLifecycleService } from '../src/modules/whatsapp-sender/connection-lifecycle.service';
import { MetaWebhookRoutingService } from '../src/infrastructure/spokes/meta/meta-webhook-routing.service';
import { WhatsAppWebhookService } from '../src/infrastructure/spokes/meta/whatsapp.webhook.service';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../src/shared/config/whatsapp-template.config';

const h = creditUsageHarness();
const customers = new CustomerMessagesRepository(h.db);
const connections = new WhatsappConnectionsRepository(h.db as never);
let nextNumber = 700000000000000;
const phone = '+201000000000';

async function fixture() {
  const source = await h.merchant(3, 'shopify');
  const input = await h.verification(source);
  const connection = await connections.saveForOrg(source.orgId, {
    wabaId: String(nextNumber++),
    phoneNumberId: String(nextNumber++),
    displayPhoneNumber: phone,
    state: 'active',
    signupPath: 'coexistence',
    businessTokenEncrypted: 'v1:synthetic:only:ciphertext',
  });
  const quotedId = `wamid.${randomUUID()}`;
  await h.db
    .update(verifications)
    .set({ waMessageId: quotedId, status: 'sent' })
    .where(eq(verifications.id, input.verificationId));
  const route: ReceivingNumber = {
    orgId: source.orgId,
    connectionId: connection.id,
    wabaId: connection.wabaId,
    phoneNumberId: connection.phoneNumberId,
  };
  return { source, input, connection, route, quotedId };
}
const incoming = (body = 'hello-private') => ({
  id: `incoming.${randomUUID()}`,
  type: 'text',
  from: phone,
  text: { body },
});
const event = (
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  offset = 1000,
) => ({
  orgId: f.source.orgId,
  connectionId: f.connection.id,
  generation: f.connection.signupGeneration,
  occurredAt: new Date(Date.now() + offset).toISOString(),
  eventKey: randomUUID(),
  event: name,
  reason: name,
});

describe('merchant webhook routing PostgreSQL contract', () => {
  beforeAll(() => h.setup());
  afterAll(() => h.teardown());

  it('admits a quote and a username without a phone, retaining its scoped identity', async () => {
    const f = await fixture();
    const message = {
      ...incoming(),
      from: undefined,
      from_user_id: 'synthetic-bsuid',
      context: { id: f.quotedId },
    };
    expect(await customers.admit(f.route, message)).toMatchObject({
      allowed: true,
      retainText: true,
      verificationId: f.input.verificationId,
    });
    expect(
      await h.db
        .select()
        .from(customerMessages)
        .where(eq(customerMessages.providerMessageId, message.id)),
    ).toEqual([
      expect.objectContaining({
        orgId: f.source.orgId,
        customerPhone: null,
        customerUserId: 'synthetic-bsuid',
        body: 'hello-private',
      }),
    ]);
    expect(
      await customers.admit(f.route, {
        ...incoming(),
        from: undefined,
        from_user_id: 'username-no-quote',
      }),
    ).toMatchObject({ retainText: false, verificationId: null });
  });

  it('rejects another merchant’s quoted or button verification even with a matching phone', async () => {
    const a = await fixture();
    const b = await fixture();
    expect(
      await customers.admit(a.route, {
        ...incoming('yes'),
        context: { id: b.quotedId },
      }),
    ).toMatchObject({ allowed: false, reason: 'foreign_verification' });
    expect(
      await customers.admit(a.route, {
        ...incoming('yes'),
        button: { payload: `confirm_${b.input.verificationId}` },
      }),
    ).toMatchObject({ allowed: false });
    expect(
      await customers.admit(a.route, {
        ...incoming('yes'),
        context: { id: b.quotedId },
        button: { payload: `confirm_${a.input.verificationId}` },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('binds an unquoted answer to one open verification and keeps it after the answer is saved', async () => {
    const f = await fixture();
    const message = incoming('yes');
    expect(await customers.admit(f.route, message)).toMatchObject({
      verificationId: f.input.verificationId,
    });
    await h.db
      .update(verifications)
      .set({ status: 'confirmed', confirmationSource: 'customer' })
      .where(eq(verifications.id, f.input.verificationId));
    expect(await customers.admit(f.route, message)).toMatchObject({
      verificationId: f.input.verificationId,
    });
    expect(
      (
        await h.db
          .select()
          .from(customerMessages)
          .where(eq(customerMessages.providerMessageId, message.id))
      ).length,
    ).toBe(1);
  });

  it('never changes an ambiguous phone answer into a different order on replay', async () => {
    const f = await fixture();
    const other = await h.verification(f.source);
    const message = incoming('no');
    await h.db
      .update(verifications)
      .set({ status: 'sent' })
      .where(eq(verifications.id, other.verificationId));
    expect(await customers.admit(f.route, message)).toMatchObject({
      verificationId: null,
      retainText: true,
    });
    await h.db
      .update(verifications)
      .set({ status: 'confirmed' })
      .where(eq(verifications.id, other.verificationId));
    expect(await customers.admit(f.route, message)).toMatchObject({
      verificationId: null,
    });
  });

  it('never uses phone matching on the shared number', async () => {
    const f = await fixture();
    expect(
      await customers.admit(
        { ...f.route, orgId: null, connectionId: null },
        incoming('yes'),
      ),
    ).toMatchObject({ retainText: false, verificationId: null });
    expect(
      await customers.admit(
        { ...f.route, orgId: null, connectionId: null },
        { ...incoming(), context: { id: f.quotedId } },
      ),
    ).toMatchObject({
      retainText: true,
      verificationId: f.input.verificationId,
    });
  });

  it('drops unrelated and expired content, with a 30-day cutoff and 90-day expiry', async () => {
    const f = await fixture();
    const message = incoming();
    await h.client`UPDATE orders SET created_at = now() - interval '31 days' WHERE org_id = ${f.source.orgId}`;
    expect(await customers.admit(f.route, message)).toMatchObject({
      retainText: false,
      verificationId: null,
    });
    expect(
      await customers.admit(f.route, {
        ...message,
        context: { id: f.quotedId },
        timestamp: String(Math.floor(Date.now() / 1000) - 91 * 86400),
      }),
    ).toMatchObject({ allowed: false, reason: 'expired_message' });
    const quoted = { ...incoming(), context: { id: f.quotedId } };
    await customers.admit(f.route, quoted);
    const [row] = await h.db
      .select()
      .from(customerMessages)
      .where(eq(customerMessages.providerMessageId, quoted.id));
    expect(
      new Date(row.expiresAt).getTime() - new Date(row.receivedAt).getTime(),
    ).toBe(90 * 86400_000);
    await h.db
      .update(customerMessages)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(customerMessages.id, row.id));
    expect(await customers.purge()).toBe(1);
  });

  it('resolves quoted older physical attempts and validates their historical receiving number after replacement', async () => {
    const f = await fixture();
    const claim = await h.dispatches.claim({
      ...f.input,
      sender: {
        kind: 'merchant_own',
        connectionId: f.connection.id,
        reason: 'own_number',
        units: 1,
      },
    });
    if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
    const attemptId = randomUUID();
    const oldWamid = `wamid.old.${randomUUID()}`;
    await h.db.insert(verificationSenderAttempts).values({
      id: attemptId,
      orgId: f.source.orgId,
      dispatchId: claim.dispatch.id,
      attemptNumber: 0,
      claimToken: randomUUID(),
      state: 'accepted',
      connectionId: f.connection.id,
      signupGeneration: 1,
      phoneNumberId: f.connection.phoneNumberId,
      wabaId: f.connection.wabaId,
      providerMessageId: oldWamid,
      leaseUntil: new Date(Date.now() + 60000).toISOString(),
    });
    await connections.markDisconnected(f.source.orgId, 'removed');
    expect(await customers.findQuoted(oldWamid)).toMatchObject({
      id: f.input.verificationId,
      orgId: f.source.orgId,
    });
    expect(
      await customers.receiptReceiverMatches(
        { id: oldWamid },
        f.connection.phoneNumberId,
        f.connection.wabaId,
        null,
      ),
    ).toBe(true);
    expect(
      await customers.receiptReceiverMatches(
        { id: oldWamid },
        'wrong-phone',
        f.connection.wabaId,
        f.route,
      ),
    ).toBe(false);
    expect(
      await customers.receiptReceiverMatches(
        { id: oldWamid },
        f.connection.phoneNumberId,
        'wrong-waba',
        f.route,
      ),
    ).toBe(false);
  });

  it.each(['PARTNER_REMOVED', 'PARTNER_APP_UNINSTALLED', 'ACCOUNT_DELETED'])(
    '%s disconnects atomically and never permits an account event to resurrect credentials',
    async (name) => {
      const f = await fixture();
      const applied = await connections.applyLifecycle(event(f, name));
      expect(applied).toMatchObject({
        state: 'disconnected',
        businessTokenEncrypted: null,
        registrationPinEncrypted: null,
      });
      expect(
        await connections.applyLifecycle(event(f, 'ACCOUNT_RECONNECTED', 2000)),
      ).toBeNull();
      expect((await connections.findByOrg(f.source.orgId))?.state).toBe(
        'disconnected',
      );
    },
  );

  it.each(['ACCOUNT_RESTRICTION', 'ACCOUNT_VIOLATION', 'DISABLED_UPDATE'])(
    '%s degrades and fences an in-progress health check',
    async (name) => {
      const f = await fixture();
      const claim = await connections.claimHealth(
        f.source.orgId,
        f.connection.id,
        1,
      );
      expect(claim).not.toBeNull();
      expect(await connections.applyLifecycle(event(f, name))).toMatchObject({
        state: 'active',
        degradedClass: 'restricted',
      });
      expect(
        await connections.completeHealth(claim, { status: 'AVAILABLE' }),
      ).toBeNull();
    },
  );

  it('offboards, reconnects through verifying and resumes only after AVAILABLE health', async () => {
    const f = await fixture();
    expect(
      await connections.applyLifecycle(event(f, 'ACCOUNT_OFFBOARDED')),
    ).toMatchObject({
      state: 'offboarded',
      businessTokenEncrypted: f.connection.businessTokenEncrypted,
    });
    expect(
      await connections.applyLifecycle(event(f, 'ACCOUNT_RECONNECTED', 2000)),
    ).toMatchObject({ state: 'verifying' });
    let claim = await connections.claimHealth(
      f.source.orgId,
      f.connection.id,
      1,
    );
    expect(
      await connections.completeHealth(claim, { status: 'LIMITED' }),
    ).toMatchObject({ state: 'verifying' });
    await connections.requestHealth(f.source.orgId, f.connection.id, 1);
    claim = await connections.claimHealth(f.source.orgId, f.connection.id, 1);
    expect(
      await connections.completeHealth(claim, { status: 'AVAILABLE' }),
    ).toMatchObject({ state: 'active' });
  });

  it('rejects duplicate, older and superseded-generation lifecycle work', async () => {
    const f = await fixture();
    const first = event(f, 'ACCOUNT_OFFBOARDED', 5000);
    expect(await connections.applyLifecycle(first)).not.toBeNull();
    expect(await connections.applyLifecycle(first)).toBeNull();
    expect(
      await connections.applyLifecycle(event(f, 'ACCOUNT_RECONNECTED', 1000)),
    ).toBeNull();
    expect(
      await connections.applyLifecycle({
        ...event(f, 'ACCOUNT_RECONNECTED', 6000),
        generation: 0,
      }),
    ).toBeNull();
  });

  it('makes one account owner win concurrent signup for different numbers', async () => {
    const a = await h.merchant();
    const b = await h.merchant();
    const wabaId = String(nextNumber++);
    const input = {
      wabaId,
      phoneNumberId: String(nextNumber++),
      displayPhoneNumber: phone,
      signupPath: 'coexistence' as const,
      businessTokenEncrypted: 'v1:synthetic:only:ciphertext',
    };
    const results = await Promise.allSettled([
      connections.saveSignupForOrg(a.orgId, input),
      connections.saveSignupForOrg(b.orgId, {
        ...input,
        phoneNumberId: String(nextNumber++),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected')?.reason,
    ).toBeInstanceOf(WhatsappAccountInUseError);
  });

  it('blocks reconnect and account takeover during cleanup, then recovers an expired lease', async () => {
    const f = await fixture();
    const old = await connections.beginDisconnect(f.source.orgId);
    expect(old?.businessTokenEncrypted).toBeTruthy();
    expect(await connections.findByOrg(f.source.orgId)).toMatchObject({
      state: 'disconnected',
      businessTokenEncrypted: null,
    });
    const signup = {
      wabaId: f.connection.wabaId,
      phoneNumberId: f.connection.phoneNumberId,
      signupPath: 'coexistence' as const,
      displayPhoneNumber: phone,
      businessTokenEncrypted: 'v1:synthetic:only:ciphertext',
    };
    expect(await connections.saveSignupForOrg(f.source.orgId, signup)).toEqual({
      saved: false,
      reason: 'connection_exists',
    });
    const other = await h.merchant();
    await expect(
      connections.saveSignupForOrg(other.orgId, {
        ...signup,
        phoneNumberId: String(nextNumber++),
      }),
    ).rejects.toBeInstanceOf(WhatsappAccountInUseError);
    await h.db
      .update(whatsappConnections)
      .set({ disconnectCleanupUntil: sql`now() - interval '1 second'` })
      .where(eq(whatsappConnections.id, f.connection.id));
    const saved = await connections.saveSignupForOrg(f.source.orgId, signup);
    expect(saved.saved).toBe(true);
    await connections.finishDisconnect(
      f.source.orgId,
      f.connection.id,
      1,
      'succeeded',
    );
    expect((await connections.findByOrg(f.source.orgId))?.state).toBe(
      'connecting',
    );
  });

  it('redacts text and retained webhook content without affecting another tenant, and refuses replay', async () => {
    const f = await fixture();
    const other = await fixture();
    const message = { ...incoming(), context: { id: f.quotedId } };
    const otherMessage = { ...incoming(), context: { id: other.quotedId } };
    await customers.admit(f.route, message);
    await customers.admit(other.route, otherMessage);
    const payload = JSON.stringify({
      entry: [
        {
          id: f.connection.wabaId,
          changes: [{ field: 'messages', value: { messages: [message] } }],
        },
      ],
    });
    await h.db
      .insert(metaWebhookEvents)
      .values({ dedupeHash: randomUUID(), field: 'messages', payload });
    await new OrdersRepository(h.db as never).redactShopifyCustomer(
      f.source.orgId,
      f.source.integrationId,
      { phones: [phone], externalOrderIds: [] },
    );
    expect(
      (
        await h.db
          .select()
          .from(customerMessages)
          .where(eq(customerMessages.providerMessageId, message.id))
      )[0],
    ).toMatchObject({
      body: null,
      customerPhone: null,
      customerUserId: null,
    });
    expect(
      (
        await h.db
          .select()
          .from(metaWebhookEvents)
          .where(eq(metaWebhookEvents.payload, payload))
      ).length,
    ).toBe(0);
    expect(await customers.admit(f.route, message)).toMatchObject({
      allowed: false,
    });
    expect(
      (
        await h.db
          .select()
          .from(customerMessages)
          .where(eq(customerMessages.providerMessageId, otherMessage.id))
      )[0].body,
    ).toBe('hello-private');
  });

  it('runs the real router and reply handler with tenant isolation and retry completion', async () => {
    const f = await fixture();
    const foreign = await fixture();
    const hub = {
      finalizeVerification: jest.fn().mockResolvedValue(undefined),
    };
    const handler = new WhatsAppWebhookService(
      new VerificationsRepository(h.db as never),
      hub as never,
      h.dispatches,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      customers,
    );
    const lifecycle = new ConnectionLifecycleService(
      connections,
      { requestHealth: jest.fn() } as never,
      { emit: jest.fn() },
    );
    const router = new MetaWebhookRoutingService(
      new ConfigService({
        [WHATSAPP_TEMPLATE_CONFIG]: parseWhatsappTemplateConfig({}),
      }),
      connections,
      customers,
      handler,
      { handleOrThrow: jest.fn() } as never,
      lifecycle,
    );
    const body = (id: string) =>
      Buffer.from(
        JSON.stringify({
          entry: [
            {
              id: f.connection.wabaId,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: f.connection.phoneNumberId },
                    messages: [
                      {
                        ...incoming('yes'),
                        button: { payload: `confirm_${id}` },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
    await router.process(
      await router.prepare(body(foreign.input.verificationId)),
    );
    expect(hub.finalizeVerification).not.toHaveBeenCalled();
    const raw = body(f.input.verificationId);
    await router.process(await router.prepare(raw));
    expect(hub.finalizeVerification).toHaveBeenCalledWith(
      f.input.verificationId,
      'confirmed',
    );
    await router.process(await router.prepare(raw), { isRetry: true });
    expect(hub.finalizeVerification).toHaveBeenLastCalledWith(
      f.input.verificationId,
      'confirmed',
      { skipIfSynced: true },
    );
  });

  it('keeps admitted text API-only and enforces tenant foreign keys', async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      h.db.insert(customerMessages).values({
        orgId: f.source.orgId,
        connectionId: other.connection.id,
        providerMessageId: randomUUID(),
        messageType: 'text',
        receivedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    const [row] = await h.client<
      { relrowsecurity: boolean; readable: boolean }[]
    >`SELECT c.relrowsecurity, has_table_privilege('authenticated', c.oid, 'SELECT') AS readable FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'customer_messages' AND n.nspname = ${h.namespace}`;
    expect(row).toEqual({ relrowsecurity: true, readable: false });
  });

  it('aborts a migration with duplicate live account owners instead of choosing one', async () => {
    await h.client`DROP INDEX whatsapp_connections_live_waba_key`;
    const a = await fixture();
    const b = await fixture();
    await h.client`UPDATE whatsapp_connections SET waba_id = ${a.connection.wabaId} WHERE id = ${b.connection.id}`;
    const migration = readFileSync(
      resolve(__dirname, '../drizzle/0090_merchant_webhook_routing.sql'),
      'utf8',
    );
    await expect(
      h.client.unsafe(migration.split('--> statement-breakpoint')[0]),
    ).rejects.toThrow('WHATSAPP_LIVE_WABA_OWNERSHIP_CONFLICT');
    await h.client`UPDATE whatsapp_connections SET waba_id = ${b.connection.wabaId} WHERE id = ${b.connection.id}`;
    for (const statement of migration.split('--> statement-breakpoint'))
      if (statement.trim()) await h.client.unsafe(statement);
  });
});
