import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import * as tables from '../src/infrastructure/database/schema';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { VerificationServiceMessagesRepository } from '../src/infrastructure/database/repositories/verification-service-messages.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import { WhatsappMessageTextsRepository } from '../src/infrastructure/database/repositories/whatsapp-message-texts.repository';
import { MessageTextsService } from '../src/modules/message-texts/message-texts.service';
import { CustomerReplyFollowUpService } from '../src/modules/verification-replies/customer-reply-follow-up.service';
import {
  MESSAGE_IMPROVEMENT_SWITCHES_OFF,
  type MessageImprovementSwitchState,
} from '../src/shared/config/whatsapp-template.config';
import type { MessagingPort } from '../src/shared/ports/messaging.port';
import { creditUsageHarness } from './contracts/credit-usage-harness';

/**
 * US-08-07 b and c against real PostgreSQL, through the real repositories
 * and the real usage accounting: an acknowledgment and a nudge are recorded
 * once each and take no usage, no credit and no dispatch (record 4.10.5).
 */
const harness = creditUsageHarness();
const { db, client, dispatches, merchant, verification, acceptance } = harness;
const STAFF = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

const switches: MessageImprovementSwitchState = {
  ...MESSAGE_IMPROVEMENT_SWITCHES_OFF,
  acknowledgment: true,
  unresolvedReplyNudge: true,
};
const textsRepository = new WhatsappMessageTextsRepository(db as never);
const serviceMessages = new VerificationServiceMessagesRepository(db as never);
let textsSent = 0;
const sendFreeFormText = jest.fn(() =>
  Promise.resolve({
    outcome: 'accepted' as const,
    providerMessageId: `wamid.text-${++textsSent}`,
  }),
);
const messagingPort: MessagingPort = {
  sendVerificationTemplate: jest.fn(),
  sendFreeFormText,
};
const followUps = new CustomerReplyFollowUpService(
  new VerificationsRepository(db as never),
  new OrdersRepository(db as never),
  dispatches,
  serviceMessages,
  new MessageTextsService(textsRepository),
  messagingPort,
  { current: () => switches } as never,
);

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

async function sentVerification(platformType: 'standalone' | 'shopify') {
  const source = await merchant(3, platformType);
  const input = await verification(source);
  const claimed = await dispatches.claim(input);
  if (claimed.outcome !== 'claimed') throw new Error(claimed.outcome);
  await acceptance(claimed.dispatch);
  return input;
}

describe('US-08-07 service messages take no usage (PostgreSQL)', () => {
  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await harness.setup();
    await client.begin(async (tx) => {
      for (const statement of readFileSync(
        resolve(__dirname, '../drizzle/0060_whatsapp_service_messages.sql'),
        'utf8',
      ).split('--> statement-breakpoint')) {
        if (statement.trim()) await tx.unsafe(statement);
      }
    });
    for (const [purpose, body] of [
      ['ack_confirmed', 'تم تأكيد طلبك رقم #{{order}} من {{store}}.'],
      ['unresolved_reply_nudge', 'يرجى الضغط على أحد الزرين.'],
      ['fallback_store_name', 'متجرنا'],
    ] as const) {
      await textsRepository.upsert({
        purpose,
        language: 'ar',
        style: 'default',
        body,
        isActive: true,
        userId: STAFF,
        auditAction: 'whatsapp-message-texts.save',
      });
    }
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await harness.teardown();
  });

  it.each(['standalone', 'shopify'] as const)(
    'a %s store: one acknowledgment and one nudge, usage and credits unchanged',
    async (platformType) => {
      const confirmed = await sentVerification(platformType);
      const open = await sentVerification(platformType);
      await db
        .update(tables.verifications)
        .set({ status: 'confirmed', confirmationSource: 'customer' })
        .where(eq(tables.verifications.id, confirmed.verificationId));
      const before = await accounting(confirmed.orgId);
      const beforeOpen = await accounting(open.orgId);
      const repliedAt = new Date().toISOString();

      for (let attempt = 0; attempt < 2; attempt++) {
        await followUps.handle({
          kind: 'acknowledgment',
          verificationId: confirmed.verificationId,
          orgId: confirmed.orgId,
          repliedAt,
          intent: 'confirmed',
        });
        await followUps.handle({
          kind: 'nudge',
          verificationId: open.verificationId,
          orgId: open.orgId,
          repliedAt,
        });
      }

      const rows = await client<
        { verification_id: string; kind: string; state: string }[]
      >`
        SELECT verification_id, kind, state FROM verification_service_messages
        WHERE verification_id IN (${confirmed.verificationId}, ${open.verificationId})
        ORDER BY kind`;
      expect(rows).toEqual([
        {
          verification_id: confirmed.verificationId,
          kind: 'acknowledgment',
          state: 'sent',
        },
        { verification_id: open.verificationId, kind: 'nudge', state: 'sent' },
      ]);
      expect(await accounting(confirmed.orgId)).toEqual(before);
      expect(await accounting(open.orgId)).toEqual(beforeOpen);
    },
  );

  it('sent each message to the provider once, in all', () => {
    expect(sendFreeFormText).toHaveBeenCalledTimes(4);
  });

  it('a failed receipt marks only the service message', async () => {
    const [row] = await client<{ provider_message_id: string }[]>`
      SELECT provider_message_id FROM verification_service_messages
      WHERE kind = 'nudge' LIMIT 1`;
    const verificationsBefore = await db.execute(
      sql`SELECT id, status, updated_at FROM verifications ORDER BY id`,
    );
    expect(
      await serviceMessages.recordDeliveryFailure(row.provider_message_id),
    ).toBe(true);
    const [after] = await client<{ state: string; skip_reason: string }[]>`
      SELECT state, skip_reason FROM verification_service_messages
      WHERE provider_message_id = ${row.provider_message_id}`;
    expect(after).toEqual({ state: 'failed', skip_reason: 'delivery_failed' });
    expect(
      await db.execute(
        sql`SELECT id, status, updated_at FROM verifications ORDER BY id`,
      ),
    ).toEqual(verificationsBefore);
    expect(await serviceMessages.recordDeliveryFailure('wamid.unknown')).toBe(
      false,
    );
  });
});
