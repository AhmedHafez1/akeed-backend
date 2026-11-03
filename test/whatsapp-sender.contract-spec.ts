import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { creditUsageHarness } from './contracts/credit-usage-harness';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { VerificationServiceMessagesRepository } from '../src/infrastructure/database/repositories/verification-service-messages.repository';
import { WhatsappConnectionTemplatesRepository } from '../src/infrastructure/database/repositories/whatsapp-connection-templates.repository';
import {
  whatsappConnections,
  whatsappTemplates,
  whatsappConnectionTemplates,
  verificationMessageDispatches,
  verificationServiceMessages,
} from '../src/infrastructure/database/schema';
import {
  FEATURE_OFF_SENDER,
  type ResolvedSender,
} from '../src/shared/ports/sender-resolver.port';
import type { SelectedCodTemplate } from '../src/shared/messaging/cod-template-selector';

const harness = creditUsageHarness();
const { db, merchant, verification, balance, client, namespace } = harness;
const config = { get: () => 'shared-phone' };
const dispatches = new VerificationMessageDispatchesRepository(
  db,
  harness.router,
  config as never,
);
const services = new VerificationServiceMessagesRepository(db, config as never);
const templates = new WhatsappConnectionTemplatesRepository(db as never);
const selected: SelectedCodTemplate = {
  registryKey: 'cod_reminder.ar.egyptian_v2',
  variantKey: 'ar.egyptian_v2',
  language: 'ar',
  templateName: 'reminder_v2',
  languageCode: 'ar_EG',
  parameterFormat: 'named',
  variables: [],
};

async function ownConnection(orgId: string) {
  const [connection] = await db
    .insert(whatsappConnections)
    .values({
      orgId,
      wabaId: '1000',
      phoneNumberId: randomUUID(),
      signupPath: 'coexistence',
      state: 'active',
      businessTokenEncrypted: 'v1:synthetic:only:ciphertext',
    })
    .returning();
  const sender: ResolvedSender = {
    kind: 'merchant_own',
    connectionId: connection.id,
    reason: 'own_number',
    units: 1,
  };
  return { connection, sender };
}

async function claim(input: Parameters<typeof dispatches.claim>[0]) {
  const result = await dispatches.claim(input);
  if (result.outcome !== 'claimed')
    throw new Error(`Expected claim: ${result.outcome}`);
  return result.dispatch;
}

describe('sender ledger PostgreSQL contract', () => {
  beforeAll(harness.setup);
  afterAll(harness.teardown);

  it.each(['standalone', 'shopify'])(
    'persists merchant identity before sending and charges the own number on %s',
    async (platform) => {
      const source = await merchant(3, platform);
      const { connection, sender } = await ownConnection(source.orgId);
      const input = await verification(source);
      const dispatch = await claim({ ...input, sender });
      expect(dispatch).toMatchObject({
        state: 'sending',
        senderKind: 'merchant_own',
        senderConnectionId: connection.id,
        senderPhoneNumberId: connection.phoneNumberId,
        senderReason: 'own_number',
      });
      // An own-number send takes half a stored credit, as one pack and a
      // spare, or one message from the own-number pool.
      if (platform === 'standalone') {
        await balance(source.orgId, 2, 0);
        expect(await harness.credits.getSummary(source.orgId)).toMatchObject({
          spareCredit: 1,
        });
      } else
        expect(dispatch).toMatchObject({
          usageReserved: true,
          billingPool: 'own_number',
          billingCost: 1,
        });
      expect(
        await dispatches.findForSender(
          randomUUID(),
          dispatch.id,
          input.verificationId,
        ),
      ).toBeNull();
      expect(
        await dispatches.findForSender(source.orgId, dispatch.id, randomUUID()),
      ).toBeNull();
    },
  );

  it('retains the merchant audit identity while an expired periodic lease enters fallback', async () => {
    const source = await merchant(3, 'shopify');
    const { connection, sender } = await ownConnection(source.orgId);
    const input = await verification(source);
    const original = await claim({ ...input, sender });
    await db
      .update(verificationMessageDispatches)
      .set({ leaseUntil: new Date(Date.now() - 1000).toISOString() })
      .where(eq(verificationMessageDispatches.id, original.id));
    await db
      .update(whatsappConnections)
      .set({ phoneNumberId: 'replacement-phone', state: 'disconnected' })
      .where(eq(whatsappConnections.id, connection.id));
    expect(
      await dispatches.claim({ ...input, sender: FEATURE_OFF_SENDER }),
    ).toMatchObject({ outcome: 'busy' });
    const retry = await dispatches.findSenderRecovery(
      source.orgId,
      original.id,
    );
    expect(retry).toMatchObject({
      id: original.id,
      attemptCount: 1,
      senderRecoveryState: 'fallback',
      senderKind: 'merchant_own',
      senderConnectionId: connection.id,
      senderPhoneNumberId: connection.phoneNumberId,
      senderReason: 'own_number',
    });
    expect(typeof retry?.billingRefundedAt).toBe('string');
  });

  it('resolves new prepaid generations independently without changing charges', async () => {
    const source = await merchant(3);
    const { sender } = await ownConnection(source.orgId);
    const input = await verification(source);
    const first = await claim({ ...input, sender });
    await dispatches.resolveNotAccepted(first.id, undefined, true);
    await balance(source.orgId, 3, 0);
    const second = await claim({ ...input, sender: FEATURE_OFF_SENDER });
    expect(second).toMatchObject({
      generation: 2,
      senderKind: 'akeed_system',
      senderConnectionId: null,
      senderPhoneNumberId: 'shared-phone',
      senderReason: 'feature_off',
    });
    await balance(source.orgId, 3, 1);
  });

  it('keeps synthetic test claims billing-exempt while recording the merchant', async () => {
    const source = await merchant(1);
    await harness.adjust(source.orgId, -1);
    const { sender } = await ownConnection(source.orgId);
    const input = await verification(source);
    const result = await claim({ ...input, sender, billingExempt: true });
    expect(result).toMatchObject({
      senderKind: 'merchant_own',
      usageReserved: false,
      metadata: { billingExempt: true },
    });
    await balance(source.orgId, 0, 0);
  });

  it('rejects another tenant connection and rolls back its credit hold', async () => {
    const a = await merchant(3);
    const b = await merchant(3);
    const { sender } = await ownConnection(b.orgId);
    await expect(
      dispatches.claim({ ...(await verification(a)), sender }),
    ).rejects.toThrow('Sender connection unavailable');
    await balance(a.orgId, 3, 0);
  });

  it('matches only the exact registry key, selected language, provider name and tenant', async () => {
    const source = await merchant(1);
    const { connection } = await ownConnection(source.orgId);
    const [registry] = await db
      .insert(whatsappTemplates)
      .values({
        key: selected.registryKey!,
        purpose: 'cod_reminder',
        language: 'ar',
        style: 'egyptian_v2',
        metaTemplateName: selected.templateName,
        metaLanguageCode: selected.languageCode,
        parameterFormat: 'named',
        variableMapping: [],
        preview: {} as never,
      })
      .returning();
    await db.insert(whatsappConnectionTemplates).values({
      orgId: source.orgId,
      connectionId: connection.id,
      templateId: registry.id,
      metaLanguageCode: 'ar_EG',
      status: 'approved',
      category: 'utility',
    });
    expect(
      await templates.findForSend(source.orgId, connection.id, selected),
    ).toEqual({ status: 'approved', category: 'utility' });
    for (const overrides of [
      { registryKey: 'cod_confirm.ar.egyptian_v2' },
      { languageCode: 'ar' },
      { language: 'en' as const },
      { templateName: 'other' },
      { registryKey: undefined },
    ])
      expect(
        await templates.findForSend(source.orgId, connection.id, {
          ...selected,
          ...overrides,
        }),
      ).toBeNull();
    expect(
      await templates.findForSend(randomUUID(), connection.id, selected),
    ).toBeNull();
    expect(
      await templates.findForSend(source.orgId, randomUUID(), selected),
    ).toBeNull();
  });

  it('records shared service sender metadata before sending, and agrees with a linked dispatch', async () => {
    const source = await merchant(3);
    const input = await verification(source);
    const service = await services.claim({
      orgId: source.orgId,
      verificationId: input.verificationId,
      kind: 'nudge',
      repliedAt: new Date().toISOString(),
    });
    expect(service).not.toBeNull();
    const [row] = await db
      .select()
      .from(verificationServiceMessages)
      .where(eq(verificationServiceMessages.id, service!.id));
    expect(row).toMatchObject({
      state: 'claimed',
      senderKind: 'akeed_system',
      senderReason: 'service_message',
      senderPhoneNumberId: 'shared-phone',
    });
    const dispatch = await claim({
      ...input,
      sender: { ...FEATURE_OFF_SENDER, reason: 'service_message' },
    });
    // 0083 adds the dispatch link used by acknowledgments.
    await services.linkDispatch(service!.id, source.orgId, dispatch.id);
    const [linked] = await db
      .select()
      .from(verificationServiceMessages)
      .where(eq(verificationServiceMessages.id, service!.id));
    expect(linked).toMatchObject({
      senderKind: dispatch.senderKind,
      senderReason: dispatch.senderReason,
      senderPhoneNumberId: dispatch.senderPhoneNumberId,
    });
  });

  it('replays the forward migration without rewriting historical sender metadata', async () => {
    const source = await merchant(1);
    const input = await verification(source);
    const [historical] = await db
      .insert(verificationMessageDispatches)
      .values({ ...input, dispatchKey: `${input.verificationId}:initial:1` })
      .returning();
    expect(historical.senderReason).toBeNull();
    for (let run = 0; run < 2; run++) {
      const statements = readFileSync(
        resolve(__dirname, '../drizzle/0087_whatsapp_dispatch_senders.sql'),
        'utf8',
      )
        .replaceAll('"public".', `"${namespace}".`)
        .split('--> statement-breakpoint');
      for (const statement of statements)
        if (statement.trim()) await client.unsafe(statement);
    }
    const [after] = await db
      .select()
      .from(verificationMessageDispatches)
      .where(eq(verificationMessageDispatches.id, historical.id));
    expect(after).toEqual(historical);
  });
});
