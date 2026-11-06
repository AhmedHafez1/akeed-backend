import type { ConfigService } from '@nestjs/config';
import type {
  LastAcceptedSender,
  WhatsappSenderReadRepository,
} from '../../infrastructure/database/repositories/whatsapp-sender-read.repository';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type { SenderAlertService } from './sender-alert.service';
import { WhatsappSenderService } from './whatsapp-sender.service';

const user: AuthenticatedUser = {
  userId: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000001',
  role: 'viewer',
  source: 'supabase',
};

function sent(
  kind: LastAcceptedSender['kind'],
  acceptedAt: string,
): LastAcceptedSender {
  return { kind, reason: null, acceptedAt, deliveryStatus: 'delivered' };
}

function service(byMessage: {
  confirmation: LastAcceptedSender | null;
  reminder: LastAcceptedSender | null;
}) {
  const config = {
    get: jest.fn(() => ({
      connectEnabled: false,
      sendingEnabled: true,
      embeddedSignupConfigId: null,
      metaAppId: null,
      connectPageBaseUrl: null,
      templateSubmitIntervalMs: 2000,
      templateBatchSize: 10,
    })),
  } as unknown as ConfigService;
  const alerts = {
    read: jest.fn().mockResolvedValue([]),
  } as unknown as SenderAlertService;
  const lastAcceptedByMessage = jest.fn().mockResolvedValue(byMessage);
  const reads = {
    lastAcceptedByMessage,
  } as unknown as WhatsappSenderReadRepository;
  return {
    sender: new WhatsappSenderService(config, alerts, reads),
    lastAcceptedByMessage,
  };
}

describe('WhatsappSenderService last accepted sends', () => {
  it('keeps the confirmation and the reminder apart, and the combined one is the later', async () => {
    const confirmation = sent('akeed_system', '2026-11-04T10:00:00.000Z');
    const reminder = sent('merchant_own', '2026-11-04T11:00:00.000Z');
    const { sender, lastAcceptedByMessage } = service({
      confirmation,
      reminder,
    });
    const result = await sender.getAvailability(user);
    expect(lastAcceptedByMessage).toHaveBeenCalledWith(user.orgId);
    expect(result.lastAccepted).toEqual({ confirmation, reminder });
    expect(result.lastAcceptedSend).toEqual(reminder);
    expect(result.available).toBe(false);
  });

  it('answers the only one there is, or nothing', async () => {
    const confirmation = sent('merchant_own', '2026-11-04T10:00:00.000Z');
    const one = service({ confirmation, reminder: null });
    expect((await one.sender.getAvailability(user)).lastAcceptedSend).toEqual(
      confirmation,
    );
    const none = service({ confirmation: null, reminder: null });
    const result = await none.sender.getAvailability(user);
    expect(result.lastAcceptedSend).toBeNull();
    expect(result.lastAccepted).toEqual({ confirmation: null, reminder: null });
  });
});
