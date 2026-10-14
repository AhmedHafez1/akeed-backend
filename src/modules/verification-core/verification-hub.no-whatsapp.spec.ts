import { VerificationHubService } from './verification-hub.service';
import type { integrations } from '../../infrastructure/database/schema';

type IntegrationRecord = typeof integrations.$inferSelect;

const integration = {
  id: 'int-1',
  orgId: 'org-1',
  followUpEnabled: true,
  followUpDelayMinutes: 120,
  escalationEnabled: true,
  escalationDelayMinutes: 360,
  quietHoursEnabled: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: 'Asia/Riyadh',
} as IntegrationRecord;

function createHub() {
  const ordersRepo = { findById: jest.fn() };
  const verificationsRepo = {
    findById: jest.fn(),
    removeMetadataKeys: jest.fn().mockResolvedValue([]),
    mergeMetadata: jest.fn().mockResolvedValue([]),
    updateByIdForOrg: jest.fn(),
  };
  const commerceOutcomes = {
    dispatch: jest.fn().mockResolvedValue({ status: 'applied' }),
  };
  const automationProducer = {
    cancelPendingReminders: jest.fn().mockResolvedValue(2),
    enqueueFollowUp: jest.fn(),
    enqueueNoReplyEscalation: jest.fn(),
  };
  const hub = new VerificationHubService(
    ordersRepo as never,
    verificationsRepo as never,
    commerceOutcomes as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    automationProducer as never,
  );
  return {
    hub,
    ordersRepo,
    verificationsRepo,
    commerceOutcomes,
    automationProducer,
  };
}

const noWhatsappRow = {
  id: 'v1',
  orgId: 'org-1',
  orderId: 'o1',
  status: 'no_whatsapp',
  deliveryErrorCode: '131026',
};

const realOrder = {
  id: 'o1',
  orgId: 'org-1',
  integrationId: 'int-1',
  externalOrderId: '12345',
  isTest: false,
};

describe('VerificationHubService.markNoWhatsApp', () => {
  it('cancels the reminders, clears the reminder hint and tags the order', async () => {
    const {
      hub,
      ordersRepo,
      verificationsRepo,
      commerceOutcomes,
      automationProducer,
    } = createHub();
    verificationsRepo.findById.mockResolvedValue(noWhatsappRow);
    ordersRepo.findById.mockResolvedValue(realOrder);

    await hub.markNoWhatsApp('v1', 'receipt');

    expect(automationProducer.cancelPendingReminders).toHaveBeenCalledWith({
      verificationId: 'v1',
      orgId: 'org-1',
    });
    expect(verificationsRepo.removeMetadataKeys).toHaveBeenCalledWith('v1', [
      'follow_up_due_at',
    ]);
    expect(commerceOutcomes.dispatch).toHaveBeenCalledTimes(1);
    expect(commerceOutcomes.dispatch).toHaveBeenCalledWith({
      orgId: 'org-1',
      integrationId: 'int-1',
      externalOrderId: '12345',
      action: 'automatic_no_whatsapp_tagging',
      correlationId: 'v1',
    });
  });

  it('does nothing when the row is no longer no_whatsapp', async () => {
    // A customer reply can land between the receipt and this call.
    const { hub, verificationsRepo, commerceOutcomes, automationProducer } =
      createHub();
    verificationsRepo.findById.mockResolvedValue({
      ...noWhatsappRow,
      status: 'confirmed',
    });

    await hub.markNoWhatsApp('v1', 'receipt');

    expect(automationProducer.cancelPendingReminders).not.toHaveBeenCalled();
    expect(commerceOutcomes.dispatch).not.toHaveBeenCalled();
  });

  it('cancels the reminders but tags nothing for a test order', async () => {
    const {
      hub,
      ordersRepo,
      verificationsRepo,
      commerceOutcomes,
      automationProducer,
    } = createHub();
    verificationsRepo.findById.mockResolvedValue(noWhatsappRow);
    ordersRepo.findById.mockResolvedValue({ ...realOrder, isTest: true });

    await hub.markNoWhatsApp('v1', 'receipt');

    expect(automationProducer.cancelPendingReminders).toHaveBeenCalled();
    expect(commerceOutcomes.dispatch).not.toHaveBeenCalled();
  });

  it('never throws, so the provider receipt is still acknowledged', async () => {
    const { hub, verificationsRepo, ordersRepo, commerceOutcomes } =
      createHub();
    verificationsRepo.findById.mockResolvedValue(noWhatsappRow);
    ordersRepo.findById.mockResolvedValue(realOrder);
    commerceOutcomes.dispatch.mockRejectedValue(new Error('store down'));

    await expect(hub.markNoWhatsApp('v1', 'receipt')).resolves.toBeUndefined();
  });

  it('follows through on a synchronous send rejection instead of marking failed', async () => {
    const { hub, verificationsRepo, ordersRepo, commerceOutcomes } =
      createHub();
    verificationsRepo.findById.mockResolvedValue(noWhatsappRow);
    ordersRepo.findById.mockResolvedValue(realOrder);

    await hub.applyInitialSendFailure('v1', 'org-1', {
      status: 'failed',
      reason: 'no_whatsapp',
    });

    expect(verificationsRepo.updateByIdForOrg).not.toHaveBeenCalled();
    expect(commerceOutcomes.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'automatic_no_whatsapp_tagging' }),
    );
  });

  it('schedules no reminder for a row an early receipt already moved', async () => {
    const {
      hub,
      ordersRepo,
      verificationsRepo,
      commerceOutcomes,
      automationProducer,
    } = createHub();
    verificationsRepo.findById.mockResolvedValue(noWhatsappRow);
    ordersRepo.findById.mockResolvedValue(realOrder);

    await hub.scheduleFollowUpAndEscalation({
      verificationId: 'v1',
      orgId: 'org-1',
      integration,
      baselineSentAt: new Date('2026-10-14T10:00:00Z'),
    });

    expect(automationProducer.enqueueFollowUp).not.toHaveBeenCalled();
    expect(automationProducer.enqueueNoReplyEscalation).not.toHaveBeenCalled();
    expect(automationProducer.cancelPendingReminders).toHaveBeenCalled();
    expect(commerceOutcomes.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'automatic_no_whatsapp_tagging' }),
    );
  });

  it('still schedules reminders for a row that was sent normally', async () => {
    const { hub, verificationsRepo, automationProducer } = createHub();
    verificationsRepo.findById.mockResolvedValue({
      ...noWhatsappRow,
      status: 'sent',
    });

    await hub.scheduleFollowUpAndEscalation({
      verificationId: 'v1',
      orgId: 'org-1',
      integration,
      baselineSentAt: new Date('2026-10-14T10:00:00Z'),
    });

    expect(automationProducer.enqueueFollowUp).toHaveBeenCalled();
    expect(automationProducer.enqueueNoReplyEscalation).toHaveBeenCalled();
    expect(automationProducer.cancelPendingReminders).not.toHaveBeenCalled();
  });
});
