import { Logger } from '@nestjs/common';
import { parseWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import {
  WHATSAPP_TEMPLATE_SYNC_EVERY_MS,
  WHATSAPP_TEMPLATE_SYNC_JOB,
  WHATSAPP_TEMPLATE_SYNC_SCHEDULER,
  WHATSAPP_TEMPLATE_SYNC_WEBHOOK_DELAY_MS,
  WHATSAPP_TEMPLATE_SYNC_WEBHOOK_JOB_ID,
} from './whatsapp-template-sync-queue.constants';
import { WhatsappTemplateSyncProducer } from './whatsapp-template-sync.producer';

function setup(syncEnabled: boolean) {
  const queue = {
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    removeJobScheduler: jest.fn().mockResolvedValue(true),
    add: jest.fn().mockResolvedValue(undefined),
  };
  const config = parseWhatsappTemplateConfig({
    WHATSAPP_TEMPLATE_SYNC_ENABLED: String(syncEnabled),
    WA_BUSINESS_ACCOUNT_ID: '100000000000001',
  });
  const producer = new WhatsappTemplateSyncProducer(
    queue as never,
    { get: () => config } as never,
  );
  return { producer, queue };
}

describe('WhatsappTemplateSyncProducer', () => {
  afterEach(() => jest.restoreAllMocks());

  it('schedules a sync every 6 hours when sync is on', async () => {
    const { producer, queue } = setup(true);

    await producer.schedule();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      WHATSAPP_TEMPLATE_SYNC_SCHEDULER,
      { every: WHATSAPP_TEMPLATE_SYNC_EVERY_MS },
      expect.objectContaining({
        name: WHATSAPP_TEMPLATE_SYNC_JOB,
        data: { trigger: 'scheduled' },
        opts: expect.objectContaining({ attempts: 1 }) as unknown,
      }),
    );
    expect(WHATSAPP_TEMPLATE_SYNC_EVERY_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('removes the schedule and asks for nothing when sync is off', async () => {
    const { producer, queue } = setup(false);

    await producer.schedule();
    await producer.requestSyncSoon();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(
      WHATSAPP_TEMPLATE_SYNC_SCHEDULER,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('collects webhook follow-ups into one delayed job', async () => {
    const { producer, queue } = setup(true);

    await producer.requestSyncSoon();
    await producer.requestSyncSoon();

    expect(queue.add).toHaveBeenCalledWith(
      WHATSAPP_TEMPLATE_SYNC_JOB,
      { trigger: 'webhook' },
      expect.objectContaining({
        jobId: WHATSAPP_TEMPLATE_SYNC_WEBHOOK_JOB_ID,
        delay: WHATSAPP_TEMPLATE_SYNC_WEBHOOK_DELAY_MS,
        removeOnComplete: true,
      }),
    );
    const jobIds = new Set(
      queue.add.mock.calls.map(
        ([, , options]) => (options as { jobId: string }).jobId,
      ),
    );
    expect(jobIds.size).toBe(1);
  });

  it('never throws when the queue is down', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { producer, queue } = setup(true);
    queue.upsertJobScheduler.mockRejectedValue(new Error('redis down'));
    queue.add.mockRejectedValue(new Error('redis down'));

    await expect(producer.schedule()).resolves.toBeUndefined();
    await expect(producer.requestSyncSoon()).resolves.toBeUndefined();
  });
});
