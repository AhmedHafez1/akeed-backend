import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import * as tables from '../src/infrastructure/database/schema';
import { VerificationChangeRequestsRepository } from '../src/infrastructure/database/repositories/verification-change-requests.repository';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { ChangeRequestAcknowledgmentService } from '../src/modules/change-requests/change-request-acknowledgment.service';
import {
  customerRecipientHash,
  CHANGE_BUTTON_LABELS,
} from '../src/shared/messaging/change-request-messaging';
import { TEMPLATE_LANGUAGES } from '../src/shared/messaging/template-registry.types';
import {
  toDraftContent,
  WhatsappTemplateDraftsRepository,
} from '../src/infrastructure/database/repositories/whatsapp-template-drafts.repository';
import {
  toTemplateSubmission,
  deriveDraftVariables,
} from '../src/shared/messaging/template-draft.validation';
import { withSerializableRetry } from '../src/shared/database/serializable-retry';
import type { FreeFormTextOutcome } from '../src/shared/ports/messaging.port';
import { WhatsAppWebhookService } from '../src/infrastructure/spokes/meta/whatsapp.webhook.service';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import { VerificationAutoCancellationsRepository } from '../src/infrastructure/database/repositories/verification-auto-cancellations.repository';
import { customerButtonPayload } from '../src/shared/messaging/change-request-messaging';
import { CustomerMessagesRepository } from '../src/infrastructure/database/repositories/customer-messages.repository';
import { WhatsappTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-templates.repository';
import { ChangeRequestTemplatesService } from '../src/modules/change-requests/change-request-templates.service';
import { toSelectedTemplate } from '../src/shared/messaging/template-selector';
import { describeMetaComponents } from '../src/infrastructure/spokes/meta/meta-template-text';
import type { WhatsAppWebhookPayloadDto } from '../src/infrastructure/spokes/meta/dto/whatsapp-webhook.dto';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

const h = creditUsageHarness();
const { db, client } = h;
const requests = new VerificationChangeRequestsRepository(db as never);
const dispatches = new VerificationMessageDispatchesRepository(
  db,
  h.router,
  new ConfigService({ WA_PHONE_NUMBER_ID: 'shared-phone' }),
);
beforeAll(h.setup);
afterAll(h.teardown);

async function fixture(
  platform = 'standalone',
  senderKind: 'akeed_system' | 'merchant_own' = 'akeed_system',
  credits = 2,
) {
  const source = await h.merchant(Math.max(credits, 1), platform);
  if (credits === 0 && platform === 'standalone')
    await h.adjust(source.orgId, -1);
  await db
    .update(tables.integrations)
    .set({
      storeName: 'STORE-ONE',
      changeRequestsEnabled: false,
      acknowledgmentEnabled: false,
      quietHoursEnabled: true,
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
    })
    .where(eq(tables.integrations.id, source.integrationId));
  const original = await h.verification(source);
  const [target] = await db
    .select({ orderId: tables.verifications.orderId })
    .from(tables.verifications)
    .where(eq(tables.verifications.id, original.verificationId));
  await db
    .update(tables.orders)
    .set({ orderNumber: 'ORDER-42' })
    .where(eq(tables.orders.id, target.orderId));
  let connection: typeof tables.whatsappConnections.$inferSelect | undefined;
  if (senderKind === 'merchant_own')
    [connection] = await db
      .insert(tables.whatsappConnections)
      .values({
        orgId: source.orgId,
        wabaId: randomUUID(),
        phoneNumberId: randomUUID(),
        signupPath: 'coexistence',
        state: 'active',
      })
      .returning();
  const initial = await dispatches.claim({
    ...original,
    billingExempt: true,
    recipientHash: customerRecipientHash('+201000000000'),
    changeRequestButtons: true,
    identity: { variantKey: 'ar.egyptian', purpose: 'initial', language: 'ar' },
    sender: {
      kind: senderKind,
      connectionId: connection?.id ?? null,
      reason: 'fixture',
      units: 1,
    },
  });
  if (initial.outcome !== 'claimed') throw new Error(initial.outcome);
  const wamid = `wamid.${randomUUID()}`;
  await h.acceptance(initial.dispatch, wamid);
  const input = {
    verificationId: original.verificationId,
    expectedOrgId: source.orgId,
    sourceProviderMessageId: wamid,
    cycle: 1,
    sender: {
      kind: senderKind,
      phoneNumberId: connection?.phoneNumberId ?? 'shared-phone',
    },
    recipientHash: customerRecipientHash('+201000000000'),
    requireChangeButton: true,
    eventId: `tap-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    shipping: 'unknown' as const,
  };
  const opened = await requests.open(input);
  if (opened.outcome !== 'opened') throw new Error(JSON.stringify(opened));
  const sendFreeFormText = jest
    .fn<Promise<FreeFormTextOutcome>, [unknown]>()
    .mockResolvedValue({
      outcome: 'accepted',
      providerMessageId: `ack-${randomUUID()}`,
    });
  const service = new ChangeRequestAcknowledgmentService(
    requests,
    dispatches,
    new OrdersRepository(db as never),
    { sendFreeFormText } as never,
  );
  return {
    source,
    original,
    initial: initial.dispatch,
    request: opened.request,
    input,
    sendFreeFormText,
    service,
    connection,
  };
}

describe('change-request transport and billing over PostgreSQL', () => {
  it('records real image/text attempts under tenant and generation fences without another reservation or debit', async () => {
    const source = await h.merchant(3);
    const params = await h.verification(source);
    const claim = await dispatches.claim({
      ...params,
      billingExempt: false,
      changeRequestButtons: true,
      identity: { variantKey: 'en.short', purpose: 'initial', language: 'en' },
      sender: {
        kind: 'akeed_system',
        connectionId: null,
        reason: 'fixture',
        units: 1,
      },
    });
    if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
    const before = await h.credits.getSummary(source.orgId);
    const reservations = await db
      .select()
      .from(tables.creditReservations)
      .where(eq(tables.creditReservations.orgId, source.orgId));
    const image = {
      variantKey: 'en.short',
      language: 'en' as const,
      templateName: 'change_short_logo',
      languageCode: 'en',
    };
    await expect(
      dispatches.recordTemplateAttempt(
        randomUUID(),
        claim.dispatch.id,
        claim.dispatch.generation,
        image,
      ),
    ).rejects.toThrow('no longer owned');
    await expect(
      dispatches.recordTemplateAttempt(
        source.orgId,
        claim.dispatch.id,
        claim.dispatch.generation + 1,
        image,
      ),
    ).rejects.toThrow('no longer owned');
    await dispatches.recordTemplateAttempt(
      source.orgId,
      claim.dispatch.id,
      claim.dispatch.generation,
      image,
    );
    expect(await dispatches.findById(claim.dispatch.id)).toMatchObject({
      templateName: 'change_short_logo',
      changeRequestButtons: true,
    });
    await dispatches.recordTemplateAttempt(
      source.orgId,
      claim.dispatch.id,
      claim.dispatch.generation,
      { ...image, templateName: 'change_short' },
    );
    expect(await dispatches.findById(claim.dispatch.id)).toMatchObject({
      templateName: 'change_short',
      changeRequestButtons: true,
    });
    expect(await h.credits.getSummary(source.orgId)).toEqual(before);
    expect(
      await db
        .select()
        .from(tables.creditReservations)
        .where(eq(tables.creditReservations.orgId, source.orgId)),
    ).toEqual(reservations);
    await h.acceptance(claim.dispatch, 'wamid.synthetic.media-fallback');
    const accepted = await h.credits.getSummary(source.orgId);
    await h.acceptance(claim.dispatch, 'wamid.synthetic.media-fallback');
    expect(await h.credits.getSummary(source.orgId)).toEqual(accepted);
    await expect(
      dispatches.recordTemplateAttempt(
        source.orgId,
        claim.dispatch.id,
        claim.dispatch.generation,
        image,
      ),
    ).rejects.toThrow('no longer owned');
  });
  it('fences a legacy answer whose initial state read raced with a new cycle', async () => {
    const f = await fixture();
    await db
      .update(tables.verifications)
      .set({ confirmationCycle: 2 })
      .where(eq(tables.verifications.id, f.original.verificationId));
    const changed = await new VerificationsRepository(db as never).updateStatus(
      f.original.verificationId,
      'confirmed',
      undefined,
      undefined,
      { confirmationSource: 'customer' },
      undefined,
      1,
    );
    expect(changed).toEqual([]);
    await db.insert(tables.verificationAutoCancellations).values({
      orgId: f.source.orgId,
      verificationId: f.original.verificationId,
      orderId: f.request.orderId,
      integrationId: f.source.integrationId,
      status: 'scheduled',
    });
    await new VerificationAutoCancellationsRepository(
      db as never,
    ).recordCustomerAnswer({
      verificationId: f.original.verificationId,
      intent: 'confirmed',
      receivedAt: new Date().toISOString(),
      expectedConfirmationCycle: 1,
    });
    const [scheduled] = await db
      .select()
      .from(tables.verificationAutoCancellations)
      .where(
        eq(
          tables.verificationAutoCancellations.verificationId,
          f.original.verificationId,
        ),
      );
    expect(scheduled.status).toBe('scheduled');
    expect(
      await requests.findOpenForVerification(
        f.original.verificationId,
        f.source.orgId,
      ),
    ).toBeDefined();
  });
  it('fences a legacy answer whose state read raced with a newer Change in the same cycle', async () => {
    const f = await fixture();
    const older = new Date(Date.parse(f.input.occurredAt) - 1000);
    const changed = await new VerificationsRepository(db as never).updateStatus(
      f.original.verificationId,
      'confirmed',
      undefined,
      String(older.getTime() / 1000),
      {
        confirmationSource: 'customer',
        customerActionAt: older.toISOString(),
        customerActionEventId: 'older-event',
      },
      undefined,
      1,
    );
    expect(changed).toEqual([]);
    expect(
      await requests.findOpenForVerification(
        f.original.verificationId,
        f.source.orgId,
      ),
    ).toBeDefined();
  });
  it('never switches an acknowledgement to a replacement shared sender', async () => {
    const f = await fixture();
    const changedSender = new VerificationMessageDispatchesRepository(
      db,
      h.router,
      new ConfigService({ WA_PHONE_NUMBER_ID: 'replacement-shared-phone' }),
    );
    const service = new ChangeRequestAcknowledgmentService(
      requests,
      changedSender,
      new OrdersRepository(db as never),
      { sendFreeFormText: f.sendFreeFormText } as never,
    );
    await service.drain(f.request.id);
    expect(f.sendFreeFormText).not.toHaveBeenCalled();
    expect(
      (await requests.listEffects(f.request.id, f.source.orgId)).find(
        (row) => row.kind === 'customer_acknowledgment',
      ),
    ).toMatchObject({
      status: 'failed',
      reason: 'originating_sender_unavailable',
    });
    await h.balance(f.source.orgId, 2, 0);
  });
  it('applies the migration to the old enum in a transaction and leaves new template definitions unapproved', async () => {
    const name = `migration_${randomUUID().replaceAll('-', '')}`;
    await client.begin(async (tx) => {
      await tx.unsafe(`CREATE SCHEMA ${name}; SET LOCAL search_path TO ${name}, public;
        CREATE TYPE verification_dispatch_kind AS ENUM ('initial', 'follow_up', 'acknowledgment');
        CREATE TABLE verifications (id uuid PRIMARY KEY);
        CREATE TABLE verification_message_dispatches (id uuid PRIMARY KEY, kind verification_dispatch_kind);
        CREATE TABLE credit_reservations (kind verification_dispatch_kind, CONSTRAINT credit_reservations_kind_check CHECK (kind::text IN ('initial','follow_up','acknowledgment')));
        CREATE TABLE whatsapp_templates (id uuid PRIMARY KEY, key text, purpose text, language text, style text, meta_language_code text, preview jsonb, header_format text DEFAULT 'none', retired_at timestamptz);
        CREATE TABLE whatsapp_template_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE, purpose text, language text, style text, version integer, meta_template_name text, meta_language_code text, parameter_format text, category text, body text, confirm_label text, cancel_label text, samples jsonb, template_id uuid, created_by uuid, updated_by uuid);
      `);
      const migration = readFileSync(
        resolve(__dirname, '../drizzle/0093_change_request_messaging.sql'),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint'))
        if (statement.trim()) await tx.unsafe(statement);
    });
    await client.unsafe(
      `INSERT INTO ${name}.verification_message_dispatches (id,kind) VALUES (gen_random_uuid(),'change_acknowledgment'); INSERT INTO ${name}.credit_reservations VALUES ('change_acknowledgment'); DROP SCHEMA ${name} CASCADE;`,
    );
  });

  it('recovers an accepted acknowledgement after effect settlement is interrupted, without sending or charging again', async () => {
    const f = await fixture();
    const settle = jest
      .spyOn(requests, 'settleEffect')
      .mockRejectedValueOnce(
        new Error('synthetic interruption after acceptance'),
      );
    await expect(f.service.drain(f.request.id)).rejects.toThrow(
      'synthetic interruption',
    );
    settle.mockRestore();
    const effect = (
      await requests.listEffects(f.request.id, f.source.orgId)
    ).find((row) => row.kind === 'customer_acknowledgment')!;
    await db
      .update(tables.verificationChangeRequestEffects)
      .set({ leaseUntil: new Date(Date.now() - 1000).toISOString() })
      .where(eq(tables.verificationChangeRequestEffects.id, effect.id));
    await f.service.drain(f.request.id);
    expect(f.sendFreeFormText).toHaveBeenCalledTimes(1);
    expect(
      (await requests.listEffects(f.request.id, f.source.orgId)).find(
        (row) => row.kind === 'customer_acknowledgment',
      )?.status,
    ).toBe('done');
    await h.balance(f.source.orgId, 1, 0);
  });

  it.each(['akeed_system', 'merchant_own'] as const)(
    'reverses one failed-delivery charge and leaves the request open (%s)',
    async (sender) => {
      const f = await fixture('standalone', sender);
      await f.service.drain(f.request.id);
      const ack = await dispatches.findChangeAcknowledgment(
        f.original.verificationId,
        f.source.orgId,
        1,
      );
      const receiver = {
        orgId: sender === 'merchant_own' ? f.source.orgId : null,
        connectionId: f.connection?.id ?? null,
        phoneNumberId: f.input.sender.phoneNumberId,
        wabaId: f.connection?.wabaId ?? 'shared-waba',
      };
      expect(
        await new CustomerMessagesRepository(
          db as never,
        ).receiptReceiverMatches(
          { id: ack.providerMessageId! },
          receiver.phoneNumberId,
          receiver.wabaId,
          receiver,
        ),
      ).toBe(true);
      await dispatches.recordProviderStatus(
        ack.id,
        'failed',
        new Date().toISOString(),
      );
      await dispatches.recordProviderStatus(
        ack.id,
        'failed',
        new Date().toISOString(),
      );
      await f.service.drain(f.request.id);
      expect(f.sendFreeFormText).toHaveBeenCalledTimes(1);
      expect(
        await requests.findOpenForVerification(
          f.original.verificationId,
          f.source.orgId,
        ),
      ).toBeDefined();
      expect(
        (await requests.listEffects(f.request.id, f.source.orgId)).find(
          (row) => row.kind === 'customer_acknowledgment',
        ),
      ).toMatchObject({ status: 'failed', reason: 'delivery_failed' });
      await h.balance(f.source.orgId, 2, 0);
    },
  );

  it('does not substitute a template after the service window closes', async () => {
    const f = await fixture();
    await db
      .update(tables.verificationChangeRequests)
      .set({ openedAt: new Date(Date.now() - 25 * 3600000).toISOString() })
      .where(eq(tables.verificationChangeRequests.id, f.request.id));
    await f.service.drain(f.request.id);
    expect(f.sendFreeFormText).not.toHaveBeenCalled();
    expect(
      (await requests.listEffects(f.request.id, f.source.orgId)).find(
        (row) => row.kind === 'customer_acknowledgment',
      ),
    ).toMatchObject({ status: 'skipped', reason: 'outside_window' });
    await h.balance(f.source.orgId, 2, 0);
  });
  it.each(['akeed_system', 'merchant_own'] as const)(
    'captures and acknowledges a versioned button, then resolves by customer button through the real webhook and repositories (%s)',
    async (sender) => {
      const f = await fixture('standalone', sender);
      await db
        .delete(tables.verificationChangeRequests)
        .where(eq(tables.verificationChangeRequests.id, f.request.id));
      await db
        .update(tables.verifications)
        .set({ customerActionAt: null, customerActionEventId: null })
        .where(eq(tables.verifications.id, f.original.verificationId));
      const hub = {
        finalizeVerification: jest.fn().mockResolvedValue(undefined),
      };
      const lifecycle = {
        openFromCustomer: (input: Parameters<typeof requests.open>[0]) =>
          requests.open({ ...input, shipping: 'unknown' }),
      };
      const webhook = new WhatsAppWebhookService(
        new VerificationsRepository(db as never),
        hub as never,
        dispatches,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        requests,
        lifecycle as never,
        f.service,
      );
      const options =
        sender === 'merchant_own'
          ? {
              receivingOrgId: f.source.orgId,
              receivingSender: {
                phoneNumberId: f.connection!.phoneNumberId,
                connectionId: f.connection!.id,
                signupGeneration: f.connection!.signupGeneration,
              },
            }
          : {};
      const payload = (
        action: 'change_requested' | 'confirmed',
        seconds: number,
      ): WhatsAppWebhookPayloadDto =>
        ({
          entry: [
            {
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: f.input.sender.phoneNumberId },
                    messages: [
                      {
                        id: `customer-${action}`,
                        from: '201000000000',
                        timestamp: String(seconds),
                        context: { id: f.input.sourceProviderMessageId },
                        button: {
                          payload: customerButtonPayload(
                            action,
                            f.original.verificationId,
                            1,
                          ),
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }) as WhatsAppWebhookPayloadDto;
      const seconds = Math.floor(Date.now() / 1000);
      await webhook.processIncomingOrThrow(
        payload('change_requested', seconds),
        options,
      );
      await webhook.processIncomingOrThrow(
        payload('change_requested', seconds),
        { ...options, isRetry: true },
      );
      expect(f.sendFreeFormText).toHaveBeenCalledTimes(1);
      expect(
        await requests.findOpenForVerification(
          f.original.verificationId,
          f.source.orgId,
        ),
      ).toBeDefined();
      await webhook.processIncomingOrThrow(
        payload('confirmed', seconds + 1),
        options,
      );
      expect(
        await requests.findOpenForVerification(
          f.original.verificationId,
          f.source.orgId,
        ),
      ).toBeUndefined();
      expect(hub.finalizeVerification).toHaveBeenCalledWith(
        f.original.verificationId,
        'confirmed',
        { skipIfSynced: true },
      );
    },
  );
  it.each(['standalone', 'shopify'])(
    'charges one logical acknowledgment for either sender using existing %s rules',
    async (platform) => {
      for (const sender of ['akeed_system', 'merchant_own'] as const) {
        const f = await fixture(platform, sender);
        await Promise.all([
          f.service.drain(f.request.id),
          f.service.drain(f.request.id),
        ]);
        expect(f.sendFreeFormText).toHaveBeenCalledTimes(1);
        expect(f.sendFreeFormText.mock.calls[0][0]).toMatchObject({
          body: expect.stringContaining('ORDER-42'),
        });
        expect(f.sendFreeFormText).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.stringContaining('STORE-ONE'),
            ...(sender === 'merchant_own'
              ? {
                  sender: expect.objectContaining({
                    phoneNumberId: f.connection!.phoneNumberId,
                    connectionId: f.connection!.id,
                  }),
                }
              : {}),
          }),
        );
        const rows = await db
          .select()
          .from(tables.verificationMessageDispatches)
          .where(
            eq(
              tables.verificationMessageDispatches.verificationId,
              f.original.verificationId,
            ),
          );
        const ack = rows.filter((row) => row.kind === 'change_acknowledgment');
        expect(ack).toHaveLength(1);
        expect(ack[0]).toMatchObject({
          state: 'accepted',
          senderKind: sender,
          billingCost:
            platform === 'standalone' && sender === 'akeed_system' ? 2 : 1,
        });
        if (platform === 'standalone')
          await h.balance(f.source.orgId, sender === 'akeed_system' ? 1 : 1, 0);
        expect(
          (await requests.listEffects(f.request.id, f.source.orgId)).find(
            (effect) => effect.kind === 'merchant_email',
          )?.status,
        ).toBe('pending');
        expect(
          await requests.findOpenForVerification(
            f.original.verificationId,
            f.source.orgId,
          ),
        ).toBeDefined();
      }
    },
  );

  it.each(['akeed_system', 'merchant_own'] as const)(
    'permanently skips exhausted allowance for %s, even after top-up',
    async (sender) => {
      const f = await fixture('standalone', sender, 0);
      await f.service.drain(f.request.id);
      expect(f.sendFreeFormText).not.toHaveBeenCalled();
      expect(
        (await requests.listEffects(f.request.id, f.source.orgId)).find(
          (effect) => effect.kind === 'customer_acknowledgment',
        ),
      ).toMatchObject({ status: 'skipped', reason: 'skipped_no_allowance' });
      await h.adjust(f.source.orgId, 3);
      await f.service.drain(f.request.id);
      expect(f.sendFreeFormText).not.toHaveBeenCalled();
      expect(
        await requests.findOpenForVerification(
          f.original.verificationId,
          f.source.orgId,
        ),
      ).toBeDefined();
    },
  );

  it('serializes a concurrent acknowledgment and normal send against the last stored credit', async () => {
    const f = await fixture('standalone', 'akeed_system', 1);
    const other = await h.verification(f.source);
    const [, normal] = await Promise.all([
      f.service.drain(f.request.id),
      withSerializableRetry(() => dispatches.claim(other)),
    ]);
    const messages =
      f.sendFreeFormText.mock.calls.length +
      (normal.outcome === 'claimed' ? 1 : 0);
    expect(messages).toBe(1);
    expect(await h.credits.checkInvariant(f.source.orgId)).toMatchObject({
      consistent: true,
    });
  });

  it.each(['rejected', 'failed', 'window_closed'] as const)(
    'preserves the request and prevents another send after provider %s',
    async (outcome) => {
      const f = await fixture();
      f.sendFreeFormText.mockResolvedValue(
        outcome === 'window_closed'
          ? { outcome }
          : { outcome, code: 'synthetic_provider_failure' },
      );
      await f.service.drain(f.request.id);
      await f.service.drain(f.request.id);
      expect(f.sendFreeFormText).toHaveBeenCalledTimes(1);
      expect(
        await requests.findOpenForVerification(
          f.original.verificationId,
          f.source.orgId,
        ),
      ).toBeDefined();
      expect(await h.credits.checkInvariant(f.source.orgId)).toMatchObject({
        consistent: true,
      });
      await h.balance(f.source.orgId, 2, outcome === 'failed' ? 1 : 0);
    },
  );

  it('ignores an older answer after a newer Change, then resolves on current-cycle Confirm without merchant contact', async () => {
    const f = await fixture();
    const old = await requests.applyCustomerAnswer({
      ...f.input,
      intent: 'canceled',
      eventId: 'old',
      occurredAt: new Date(Date.parse(f.input.occurredAt) - 1000).toISOString(),
    });
    expect(old).toMatchObject({
      outcome: 'rejected',
      reason: 'older_customer_choice',
    });
    const input = {
      ...f.input,
      intent: 'confirmed' as const,
      eventId: 'new',
      occurredAt: new Date(Date.parse(f.input.occurredAt) + 1000).toISOString(),
    };
    expect(await requests.applyCustomerAnswer(input)).toMatchObject({
      outcome: 'applied',
    });
    expect(await requests.applyCustomerAnswer(input)).toMatchObject({
      outcome: 'already_applied',
    });
    expect(await requests.findById(f.request.id, f.source.orgId)).toMatchObject(
      { status: 'resolved', resolution: 'customer_confirmed' },
    );
    expect(
      (await requests.open({ ...f.input, eventId: 'late-change' })).outcome,
    ).toBe('rejected');
  });

  it.each(['confirmed', 'canceled'] as const)(
    'applies %s and closes the request atomically',
    async (intent) => {
      const f = await fixture();
      expect(
        await requests.applyCustomerAnswer({
          ...f.input,
          intent,
          eventId: 'newest',
          occurredAt: new Date(Date.now() + 1000).toISOString(),
        }),
      ).toMatchObject({ outcome: 'applied' });
      expect(
        await requests.findOpenForVerification(
          f.original.verificationId,
          f.source.orgId,
        ),
      ).toBeUndefined();
      expect(
        (await requests.listHistory(f.request.id, f.source.orgId)).filter(
          (event) => event.event === 'resolved',
        ),
      ).toHaveLength(1);
    },
  );

  it('refuses tenant, recipient, sender, message and cycle tampering even when another store has the same phone', async () => {
    const a = await fixture();
    const b = await fixture('standalone', 'merchant_own');
    for (const patch of [
      { expectedOrgId: b.source.orgId },
      { recipientHash: customerRecipientHash('+201999999999') },
      { sender: b.input.sender },
      { sourceProviderMessageId: b.input.sourceProviderMessageId },
      { cycle: 2 },
    ]) {
      expect(
        (
          await requests.applyCustomerAnswer({
            ...a.input,
            ...patch,
            intent: 'confirmed',
            eventId: randomUUID(),
          })
        ).outcome,
      ).toBe('rejected');
    }
    expect(
      await requests.findOpenForVerification(
        a.original.verificationId,
        a.source.orgId,
      ),
    ).toBeDefined();
  });

  it('deduplicates repeated taps and keeps valid sent buttons working after disabling', async () => {
    const f = await fixture(); // Feature is already off: eligibility comes from the sent dispatch.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        requests.open({
          ...f.input,
          eventId: `repeat-${randomUUID()}`,
          occurredAt: new Date(Date.now() + 1000).toISOString(),
        }),
      ),
    );
    expect(results.some((result) => result.outcome === 'already_open')).toBe(
      true,
    );
    expect(
      (await requests.listEffects(f.request.id, f.source.orgId)).filter(
        (effect) => effect.kind === 'customer_acknowledgment',
      ),
    ).toHaveLength(1);
  });

  it('prepares every registered variant without forging provider approval', async () => {
    for (const language of TEMPLATE_LANGUAGES)
      for (const style of language === 'ar'
        ? ['standard', 'egyptian', 'gulf', 'short']
        : language === 'en'
          ? ['friendly', 'professional', 'direct', 'short']
          : ['standard', 'short'])
        await db.insert(tables.whatsappTemplates).values({
          key: `cod_confirm.${language}.${style}`,
          purpose: 'cod_confirmation',
          language,
          style,
          metaTemplateName: `synthetic_${style}`,
          metaLanguageCode: language,
          parameterFormat: 'named',
          variableMapping: [{ key: 'order', name: 'order' }],
          preview: {
            greeting: '',
            body: 'Order {{order}}',
            totalLabel: '',
            ending: '',
            confirmButton: 'Confirm',
            cancelButton: 'Cancel',
          },
          isDefault: style === 'standard',
        });
    const migration = readFileSync(
      resolve(__dirname, '../drizzle/0093_change_request_messaging.sql'),
      'utf8',
    );
    // Re-running preparation is safe and leaves existing definitions unmodified.
    for (const statement of migration.split('--> statement-breakpoint'))
      if (statement.trim()) await client.unsafe(statement);
    const drafts = await db.select().from(tables.whatsappTemplateDrafts);
    expect(drafts).toHaveLength(16);
    for (const draft of drafts) {
      expect(draft).toMatchObject({
        state: 'draft',
        templateId: null,
        changeLabel: CHANGE_BUTTON_LABELS[draft.language],
      });
      expect(
        toTemplateSubmission(toDraftContent(draft)).buttons.map(
          (button) => button.text,
        ),
      ).toEqual(['Confirm', 'Cancel', CHANGE_BUTTON_LABELS[draft.language]]);
    }
    const draft = drafts[0];
    const content = toDraftContent(draft);
    const submitted = await new WhatsappTemplateDraftsRepository(
      db as never,
    ).confirmSubmission(
      draft.id,
      {
        result: {
          providerTemplateId: 'synthetic-pending-template',
          status: 'pending',
          category: 'utility',
        },
        variables: deriveDraftVariables(
          content.body,
          content.parameterFormat,
          content.samples,
        ),
      },
      {
        userId: randomUUID(),
        action: 'synthetic-template-submit',
        metadata: {},
      },
    );
    const [registered] = await db
      .select()
      .from(tables.whatsappTemplates)
      .where(eq(tables.whatsappTemplates.key, submitted.templateKey));
    expect(registered).toMatchObject({
      changeRequestOfKey: draft.changeRequestOfKey,
      isActive: false,
      isDefault: false,
      reviewStatus: 'pending',
      preview: expect.objectContaining({ changeButton: draft.changeLabel }),
    });
    const registry = new WhatsappTemplatesRepository(db as never);
    const parent = (await registry.findAll()).find(
      (row) => row.key === draft.changeRequestOfKey,
    )!;
    const sender = {
      kind: 'akeed_system' as const,
      connectionId: null,
      reason: 'fixture',
      units: 1 as const,
    };
    const readiness = new ChangeRequestTemplatesService(
      { listTemplates: () => registry.findAll(), invalidate: () => undefined },
      { resolve: () => Promise.resolve(sender) },
      {} as never,
      registry,
      { describeComponents: describeMetaComponents } as never,
    );
    expect(
      await readiness.counterpart(
        toSelectedTemplate(parent),
        'synthetic-org',
        sender,
      ),
    ).toBeNull();
    // Synthetic provider approval: no live template is submitted by this contract.
    await db
      .update(tables.whatsappTemplates)
      .set({
        isActive: true,
        reviewStatus: 'approved',
        lastSyncedAt: new Date().toISOString(),
        componentsSnapshot: {
          body: content.body,
          buttons: toTemplateSubmission(content).buttons,
        },
      })
      .where(eq(tables.whatsappTemplates.id, registered.id));
    expect(
      await readiness.counterpart(
        toSelectedTemplate(parent),
        'synthetic-org',
        sender,
      ),
    ).toMatchObject({
      changeRequestOfKey: parent.key,
      variantKey: `${parent.language}.${parent.style}`,
    });
  });
});
