import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import {
  createMetaSignupFake,
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  FAKE_CODE,
  FAKE_PHONE_NUMBER_ID,
  FAKE_WABA_ID,
} from './contracts/meta-signup-fake';
import {
  createMetaSetupFake,
  defaultSetupState,
} from './contracts/meta-own-number-setup-fake';
import { inspected } from './fixtures/whatsapp-connection-setup.fixtures';
import * as schema from '../src/infrastructure/database/schema';
import { WhatsappConnectionsRepository } from '../src/infrastructure/database/repositories/whatsapp-connections.repository';
import { WhatsappConnectTicketsRepository } from '../src/infrastructure/database/repositories/whatsapp-connect-tickets.repository';
import { WhatsappConnectionTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-connection-templates.repository';
import { WhatsappTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-templates.repository';
import { MembershipsRepository } from '../src/infrastructure/database/repositories/memberships.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { IntegrationsRepository } from '../src/infrastructure/database/repositories/integrations.repository';
import { UsageAlertsRepository } from '../src/infrastructure/database/repositories/usage-alerts.repository';
import { WhatsappSenderAlertsRepository } from '../src/infrastructure/database/repositories/whatsapp-sender-alerts.repository';
import { MetaWebhookEventsRepository } from '../src/infrastructure/database/repositories/meta-webhook-events.repository';
import { CustomerMessagesRepository } from '../src/infrastructure/database/repositories/customer-messages.repository';
import { VerificationServiceMessagesRepository } from '../src/infrastructure/database/repositories/verification-service-messages.repository';
import { OwnNumberGraphClient } from '../src/infrastructure/spokes/meta/own-number/own-number-graph.client';
import { MetaWebhookEventsService } from '../src/infrastructure/spokes/meta/meta-webhook-events.service';
import { MetaWebhookRoutingService } from '../src/infrastructure/spokes/meta/meta-webhook-routing.service';
import { WhatsAppWebhookService } from '../src/infrastructure/spokes/meta/whatsapp.webhook.service';
import { classifyOwnNumberFailure } from '../src/infrastructure/spokes/meta/own-number/own-number-send-failure.policy';
import { WhatsappConnectService } from '../src/modules/whatsapp-sender/whatsapp-connect.service';
import { ConnectionSetupService } from '../src/modules/whatsapp-sender/connection-setup.service';
import { ConnectionTemplatesService } from '../src/modules/whatsapp-sender/connection-templates.service';
import { ConnectionHealthService } from '../src/modules/whatsapp-sender/connection-health.service';
import { ConnectionLifecycleService } from '../src/modules/whatsapp-sender/connection-lifecycle.service';
import { ConnectionStatusService } from '../src/modules/whatsapp-sender/connection-status.service';
import { SenderResolverService } from '../src/modules/whatsapp-sender/sender-resolver.service';
import { SenderAlertService } from '../src/modules/whatsapp-sender/sender-alert.service';
import { VerificationSendService } from '../src/modules/verification-core/verification-send.service';
import { CustomerReplyFollowUpService } from '../src/modules/verification-replies/customer-reply-follow-up.service';
import { MerchantMessageFailure } from '../src/shared/ports/sender-recovery.port';
import type { MessagingPort } from '../src/shared/ports/messaging.port';
import { seededTemplateRegistry } from '../src/shared/messaging/testing/seeded-template-registry';
import {
  parseWhatsappOwnNumberConfig,
  WHATSAPP_OWN_NUMBER_CONFIG,
} from '../src/shared/config/whatsapp-own-number.config';
import {
  parseMetaGraphConfig,
  META_GRAPH_CONFIG,
} from '../src/shared/config/meta-graph.config';
import {
  parseWhatsappTemplateConfig,
  WHATSAPP_TEMPLATE_CONFIG,
} from '../src/shared/config/whatsapp-template.config';
import {
  parseUsageAlertsConfig,
  USAGE_ALERTS_CONFIG,
} from '../src/shared/config/usage-alerts.config';

const h = creditUsageHarness();
const connections = new WhatsappConnectionsRepository(h.db as never);
const rows = new WhatsappConnectionTemplatesRepository(h.db as never);
const registry = new WhatsappTemplatesRepository(h.db as never);
const key = 'c'.repeat(64);

/** There is one template, so no pacing delay is needed in this fixture. */
class ImmediateTemplates extends ConnectionTemplatesService {
  protected pause(): Promise<void> {
    return Promise.resolve();
  }
}

describe('merchant number from signup to customer reply', () => {
  beforeAll(async () => {
    await h.setup();
    const connectionSql = readFileSync(
      resolve(__dirname, '../drizzle/0085_whatsapp_connections.sql'),
      'utf8',
    );
    const tickets = connectionSql
      .split('--> statement-breakpoint')
      .find((part) =>
        part.includes('CREATE TABLE IF NOT EXISTS "whatsapp_connect_tickets"'),
      )!;
    await h.client.unsafe(tickets);
    const alertSql = readFileSync(
      resolve(__dirname, '../drizzle/0091_whatsapp_sender_alerts.sql'),
      'utf8',
    );
    for (const statement of alertSql.split('--> statement-breakpoint'))
      if (statement.trim()) await h.client.unsafe(statement);
  });
  afterAll(h.teardown);
  afterEach(() => jest.restoreAllMocks());

  it.each(['standalone', 'shopify'])(
    'runs the same continuous flow with %s accounting',
    async (platform) => {
      const source = await h.merchant(10, platform);
      const userId = randomUUID();
      await h.db
        .insert(schema.memberships)
        .values({ orgId: source.orgId, userId, role: 'owner' });
      await h.db
        .update(schema.integrations)
        .set({ defaultLanguage: 'en', acknowledgmentEnabled: true })
        .where(eq(schema.integrations.id, source.integrationId));
      const env = {
        WHATSAPP_OWN_NUMBER_CONNECT_ENABLED: 'true',
        WHATSAPP_OWN_NUMBER_SENDING_ENABLED: 'true',
        META_APP_ID: FAKE_APP_ID,
        META_EMBEDDED_SIGNUP_CONFIG_ID: '123',
        WHATSAPP_CONNECT_PAGE_BASE_URL: 'https://app.example.test',
        SHOPIFY_TOKEN_ENCRYPTION_KEY: key,
      };
      const config = new ConfigService({
        ...env,
        META_APP_SECRET: FAKE_APP_SECRET,
        WA_PHONE_NUMBER_ID: 'shared-phone',
        [WHATSAPP_OWN_NUMBER_CONFIG]: parseWhatsappOwnNumberConfig(env),
        [META_GRAPH_CONFIG]: parseMetaGraphConfig({}),
        [WHATSAPP_TEMPLATE_CONFIG]: parseWhatsappTemplateConfig({}),
        [USAGE_ALERTS_CONFIG]: parseUsageAlertsConfig({
          EMAIL_ALERTS_ENABLED: 'true',
          RESEND_API_KEY: 'synthetic',
          EMAIL_FROM: 'test@example.test',
          APP_DASHBOARD_URL: 'https://app.example.test',
        }),
      });
      const signupFake = createMetaSignupFake();
      const state = defaultSetupState();
      state.phones[FAKE_PHONE_NUMBER_ID] = {
        is_on_biz_app: true,
        platform_type: 'CLOUD_API',
        status: 'CONNECTED',
      };
      const setupFake = createMetaSetupFake(state);
      jest.spyOn(global, 'fetch').mockImplementation((async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        return /oauth\/access_token|debug_token/.test(url.pathname)
          ? signupFake.fetch(input, init)
          : setupFake.fetch(input, init);
      }) as typeof fetch);
      const graph = new OwnNumberGraphClient(config);
      const queue = {
        enqueueSetup: jest.fn().mockResolvedValue(true),
        requestTemplateSync: jest.fn().mockResolvedValue(true),
        requestHealth: jest.fn().mockResolvedValue(true),
      };
      const events = { emit: jest.fn().mockResolvedValue(undefined) };
      const connect = new WhatsappConnectService(
        config,
        new WhatsappConnectTicketsRepository(h.db as never),
        connections,
        new MembershipsRepository(h.db as never),
        graph,
        queue as never,
      );
      const user = {
        userId,
        orgId: source.orgId,
        role: 'owner' as const,
        source: 'supabase' as const,
      };
      const issued = await connect.issueTicket(user, 'en');
      const ticket = new URL(issued.connectUrl).searchParams.get('ticket')!;
      const claimed = await connect.claimTicket(ticket);
      await expect(connect.claimTicket(ticket)).rejects.toThrow();
      await connect.completeSignup({
        signupTicket: claimed.signupTicket,
        code: FAKE_CODE,
        wabaIds: [FAKE_WABA_ID],
        phoneNumberId: FAKE_PHONE_NUMBER_ID,
        isOnBusinessApp: true,
      });
      let connection = (await connections.findByOrg(source.orgId))!;
      const fixture = inspected({ id: randomUUID() });
      const existing = await registry.findAllForInspection();
      if (!existing.length)
        await h.db.insert(schema.whatsappTemplates).values({
          id: fixture.id,
          key: fixture.template.key,
          purpose: 'cod_confirmation',
          language: 'en',
          style: 'friendly',
          metaTemplateName: fixture.template.templateName,
          metaLanguageCode: 'en',
          parameterFormat: 'named',
          variableMapping: [
            { key: 'customer', name: 'customer' },
            { key: 'order', name: 'order' },
          ],
          preview: fixture.template.preview,
          isActive: true,
          isDefault: true,
          reviewStatus: 'approved',
          category: 'utility',
          componentsSnapshot: fixture.components,
        });
      const templates = new ImmediateTemplates(
        config,
        connections,
        rows,
        registry,
        graph,
        queue as never,
      );
      await new ConnectionSetupService(
        config,
        connections,
        graph,
        templates,
        queue as never,
      ).run(connection.id, connection.signupGeneration);
      connection = (await connections.findByOrg(source.orgId))!;
      expect(connection.state).toBe('verifying');
      state.templatesByWaba[FAKE_WABA_ID].forEach((template) => {
        template.status = 'APPROVED';
      });
      await templates.syncConnection(connection.id);
      const health = new ConnectionHealthService(
        connections,
        {
          check: () =>
            Promise.resolve({
              status: 'AVAILABLE' as const,
              qualityRating: 'GREEN',
            }),
        },
        events,
        queue as never,
      );
      await health.run(
        source.orgId,
        connection.id,
        connection.signupGeneration,
      );
      connection = (await connections.findByOrg(source.orgId))!;
      expect(connection.state).toBe('active');
      expect(
        setupFake.requests.filter((r) => /\/register$/.test(r.path)),
      ).toHaveLength(0);
      const status = new ConnectionStatusService(
        connections,
        rows,
        registry,
        config,
      );
      expect(
        (await status.forOrganization(source.orgId))?.templateDetails[0]
          .readiness.kind,
      ).toBe('merchant_own');
      expect(await status.forOrganization(randomUUID())).toBeNull();
      const resolver = new SenderResolverService(config, connections, rows);
      let failMerchant = false;
      const messaging = {
        sendVerificationTemplate: jest.fn(
          async (
            params: Parameters<MessagingPort['sendVerificationTemplate']>[0],
          ) => {
            if (params.sender?.kind === 'merchant_own') {
              const context = params.dispatchContext!;
              expect(
                await h.dispatches.authorizeMerchantAttempt(
                  source.orgId,
                  context.dispatchId,
                  context.merchantAttempt!,
                ),
              ).toBe(true);
            }
            if (failMerchant && params.sender?.kind === 'merchant_own')
              throw new MerchantMessageFailure(
                classifyOwnNumberFailure({ code: 131042 }),
              );
            return { messages: [{ id: `wamid.${randomUUID()}` }] };
          },
        ),
        sendFreeFormText: jest.fn(() =>
          Promise.resolve({
            outcome: 'accepted' as const,
            providerMessageId: `wamid.${randomUUID()}`,
          }),
        ),
      };
      const send = new VerificationSendService(
        new VerificationsRepository(h.db as never),
        new OrdersRepository(h.db as never),
        { evaluateAccess: () => ({ allowed: true }) } as never,
        { resolveDenial: () => Promise.resolve(null) } as never,
        h.dispatches,
        messaging,
        seededTemplateRegistry(
          (await registry.findAllForInspection()).map((t) => t.template),
        ),
        undefined,
        undefined,
        undefined,
        undefined,
        resolver,
        undefined,
        events,
      );
      const first = await h.verification(source);
      expect(await send.sendInitial(first.verificationId)).toMatchObject({
        status: 'sent',
      });
      const firstDispatch = (
        await h.db
          .select()
          .from(schema.verificationMessageDispatches)
          .where(
            eq(
              schema.verificationMessageDispatches.verificationId,
              first.verificationId,
            ),
          )
      )[0];
      expect(firstDispatch).toMatchObject({
        senderKind: 'merchant_own',
        billingCost: 1,
        billingPool: platform === 'standalone' ? 'credits' : 'own_number',
      });
      const second = await h.verification(source);
      failMerchant = true;
      expect(await send.sendInitial(second.verificationId)).toMatchObject({
        status: 'sent',
      });
      const fallbackRows = await h.db
        .select()
        .from(schema.verificationMessageDispatches)
        .where(
          eq(
            schema.verificationMessageDispatches.verificationId,
            second.verificationId,
          ),
        );
      expect(fallbackRows).toHaveLength(2);
      expect(
        fallbackRows.find((row) => row.senderKind === 'akeed_system'),
      ).toMatchObject({
        state: 'accepted',
        billingCost: platform === 'standalone' ? 2 : 1,
      });
      expect(
        fallbackRows.find((row) => row.senderKind === 'merchant_own')
          ?.billingRefundedAt,
      ).not.toBeNull();
      expect(messaging.sendVerificationTemplate).toHaveBeenCalledTimes(3);
      const capturedEmail = {
        send: jest.fn().mockResolvedValue({ status: 'sent' }),
      };
      const alerts = new SenderAlertService(
        new WhatsappSenderAlertsRepository(h.db),
        new IntegrationsRepository(h.db as never, config),
        {
          findOwnerEmail: () => Promise.resolve('owner@example.test'),
        } as unknown as UsageAlertsRepository,
        config,
        capturedEmail,
      );
      await alerts.evaluate(source.orgId, connection.signupGeneration);
      expect(
        (await alerts.read(source.orgId)).some(
          (alert) => alert.kind === 'payment',
        ),
      ).toBe(true);
      expect(capturedEmail.send).toHaveBeenCalledTimes(1);
      await alerts.evaluate(source.orgId, connection.signupGeneration);
      expect(capturedEmail.send).toHaveBeenCalledTimes(1);
      const customers = new CustomerMessagesRepository(h.db);
      const finalize = {
        finalizeVerification: jest.fn().mockResolvedValue(undefined),
      };
      const handler = new WhatsAppWebhookService(
        new VerificationsRepository(h.db as never),
        finalize as never,
        h.dispatches,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        send,
        customers,
      );
      const lifecycle = new ConnectionLifecycleService(
        connections,
        queue as never,
        events,
      );
      const templateHandler = {
        handleOrThrow: jest.fn().mockResolvedValue(undefined),
      };
      const router = new MetaWebhookRoutingService(
        config,
        connections,
        customers,
        handler,
        templateHandler as never,
        lifecycle,
      );
      const jobs: { data: { eventId: string } }[] = [];
      const durable = new MetaWebhookEventsService(
        {
          addBulk: (batch: typeof jobs) => {
            jobs.push(...batch);
            return Promise.resolve();
          },
        } as never,
        new MetaWebhookEventsRepository(h.db),
        handler,
        templateHandler as never,
        router,
        customers,
      );
      const webhook = (verificationId: string) =>
        Buffer.from(
          JSON.stringify({
            entry: [
              {
                id: FAKE_WABA_ID,
                changes: [
                  {
                    field: 'messages',
                    value: {
                      metadata: { phone_number_id: FAKE_PHONE_NUMBER_ID },
                      messages: [
                        {
                          id: `incoming-${verificationId}`,
                          type: 'button',
                          from: '201000000000',
                          timestamp: String(Math.floor(Date.now() / 1000)),
                          button: {
                            payload: `confirm_${verificationId}`,
                            text: 'Confirm',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          }),
        );
      const foreign = await h.verification(await h.merchant(1));
      await durable.accept(webhook(foreign.verificationId));
      await new Promise((resolve) => setImmediate(resolve));
      for (const job of jobs.splice(0)) await durable.process(job.data.eventId);
      expect(finalize.finalizeVerification).not.toHaveBeenCalled();
      const customerReply = webhook(first.verificationId);
      await durable.accept(customerReply);
      await new Promise((resolve) => setImmediate(resolve));
      const savedJobs = jobs.splice(0);
      for (const job of savedJobs) await durable.process(job.data.eventId);
      await durable.accept(customerReply);
      expect(finalize.finalizeVerification).toHaveBeenCalledTimes(1);
      expect(jobs).toHaveLength(0);
      await h.db
        .update(schema.verifications)
        .set({ status: 'confirmed', confirmationSource: 'customer' })
        .where(eq(schema.verifications.id, first.verificationId));
      await health.run(
        source.orgId,
        connection.id,
        connection.signupGeneration,
      );
      const followUp = new CustomerReplyFollowUpService(
        new VerificationsRepository(h.db as never),
        new OrdersRepository(h.db as never),
        h.dispatches,
        new VerificationServiceMessagesRepository(h.db),
        {
          resolve: () =>
            Promise.resolve({ body: 'Thank you', style: 'default' }),
        } as never,
        messaging,
        undefined,
        undefined,
        connections,
        config,
      );
      const before =
        await h.client`SELECT * FROM credit_accounts WHERE org_id = ${source.orgId}`;
      expect(
        await followUp.handle({
          kind: 'acknowledgment',
          verificationId: first.verificationId,
          orgId: source.orgId,
          repliedAt: new Date().toISOString(),
          intent: 'confirmed',
          receivingSender: {
            connectionId: connection.id,
            phoneNumberId: connection.phoneNumberId,
            signupGeneration: connection.signupGeneration,
          },
        }),
      ).toMatchObject({ outcome: 'sent' });
      expect(messaging.sendFreeFormText).toHaveBeenCalledTimes(1);
      expect(
        await h.client`SELECT * FROM credit_accounts WHERE org_id = ${source.orgId}`,
      ).toEqual(before);
      // Payment recovery comes from a fresh health observation; old generation work is fenced.
      await health.run(
        source.orgId,
        connection.id,
        connection.signupGeneration,
      );
      failMerchant = false;
      const recovered = await h.verification(source);
      await send.sendInitial(recovered.verificationId);
      await alerts.evaluate(source.orgId, connection.signupGeneration);
      expect(await alerts.read(source.orgId)).toEqual([]);
      config.set(
        WHATSAPP_OWN_NUMBER_CONFIG,
        parseWhatsappOwnNumberConfig({
          ...env,
          WHATSAPP_OWN_NUMBER_SENDING_ENABLED: 'false',
        }),
      );
      expect(await resolver.predict(source.orgId)).toBe('akeed_system');
      await connections.markDisconnected(source.orgId, 'PARTNER_REMOVED');
      const replaced = await connections.saveSignupForOrg(source.orgId, {
        wabaId: FAKE_WABA_ID,
        phoneNumberId: FAKE_PHONE_NUMBER_ID,
        displayPhoneNumber: '+201005550101',
        signupPath: 'coexistence',
        businessTokenEncrypted: connection.businessTokenEncrypted!,
      });
      expect(replaced.saved).toBe(true);
      expect(
        await new ConnectionSetupService(
          config,
          connections,
          graph,
          templates,
          queue as never,
        ).run(connection.id, connection.signupGeneration),
      ).toBe(false);
      await connections.markDisconnected(source.orgId, 'fixture_complete');
    },
  );
});
