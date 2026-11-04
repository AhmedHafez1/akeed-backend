import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import type { ConnectionSetupService } from './connection-setup.service';
import type { ConnectionTemplatesService } from './connection-templates.service';
import {
  CONNECTION_SETUP_JOB,
  CONNECTION_SETUP_SWEEP_JOB,
  CONNECTION_TEMPLATE_SYNC_ALL_JOB,
  CONNECTION_TEMPLATE_SYNC_JOB,
  type WhatsappConnectionSetupJobData,
} from './whatsapp-connection-setup-queue.constants';
import { WhatsappConnectionSetupProcessor } from './whatsapp-connection-setup.processor';
import { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';
import { WhatsappConnectionSetupScheduler } from './whatsapp-connection-setup.scheduler';

type SetupQueue = Queue<WhatsappConnectionSetupJobData>;

describe('WhatsappConnectionSetupProducer', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => {
        logs.push(String(args[0]));
      });
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('queues one attempt per request, never retried by the queue', async () => {
    const queue = {
      add: jest.fn<Promise<unknown>, unknown[]>(() => Promise.resolve({})),
    };
    const producer = new WhatsappConnectionSetupProducer(
      queue as unknown as SetupQueue,
    );
    await expect(producer.enqueueSetup('conn-1', 2, 5_000)).resolves.toBe(true);
    expect(queue.add).toHaveBeenCalledWith(
      CONNECTION_SETUP_JOB,
      { connectionId: 'conn-1', signupGeneration: 2 },
      expect.objectContaining({
        attempts: 1,
        delay: 5_000,
        jobId: expect.stringMatching(/^wa-setup-conn-1-2-\d+$/) as string,
      }),
    );
  });

  it('collects template syncs for one account into one job', async () => {
    const queue = {
      add: jest.fn<Promise<unknown>, unknown[]>(() => Promise.resolve({})),
    };
    const producer = new WhatsappConnectionSetupProducer(
      queue as unknown as SetupQueue,
    );
    await producer.requestTemplateSync('conn-1');
    await producer.requestTemplateSync('conn-1');
    const ids = queue.add.mock.calls.map(
      (call) => (call[2] as { jobId: string }).jobId,
    );
    expect(new Set(ids)).toEqual(new Set(['wa-template-sync-conn-1']));
    expect(queue.add.mock.calls[0][0]).toBe(CONNECTION_TEMPLATE_SYNC_JOB);
  });

  it('answers false, without throwing, while the queue is down', async () => {
    const queue = {
      add: jest.fn<Promise<unknown>, unknown[]>(() =>
        Promise.reject(new Error('ECONNREFUSED redis://secret@host')),
      ),
    };
    const producer = new WhatsappConnectionSetupProducer(
      queue as unknown as SetupQueue,
    );
    await expect(producer.enqueueSetup('conn-1', 1)).resolves.toBe(false);
    await expect(producer.requestTemplateSync('conn-1')).resolves.toBe(false);
    expect(logs.join('\n')).toContain('queue_unavailable');
    expect(logs.join('\n')).not.toContain('secret');
  });
});

describe('WhatsappConnectionSetupProcessor', () => {
  function setup() {
    const setupService = {
      run: jest.fn().mockResolvedValue(true),
      sweep: jest.fn().mockResolvedValue(0),
    };
    const templates = { syncConnection: jest.fn().mockResolvedValue({}) };
    const connections = {
      findForTemplateSync: jest.fn().mockResolvedValue([
        { id: 'conn-1', signupGeneration: 1 },
        { id: 'conn-2', signupGeneration: 4 },
      ]),
    };
    const producer = { requestTemplateSync: jest.fn().mockResolvedValue(true) };
    const processor = new WhatsappConnectionSetupProcessor(
      setupService as unknown as ConnectionSetupService,
      templates as unknown as ConnectionTemplatesService,
      connections as unknown as WhatsappConnectionsRepository,
      producer as unknown as WhatsappConnectionSetupProducer,
    );
    const job = (name: string, data: unknown) =>
      ({ name, data }) as Job<WhatsappConnectionSetupJobData>;
    return { processor, setupService, templates, producer, job };
  }

  it('routes each job to its work', async () => {
    const s = setup();
    await s.processor.process(
      s.job(CONNECTION_SETUP_JOB, {
        connectionId: 'conn-1',
        signupGeneration: 3,
      }),
    );
    expect(s.setupService.run).toHaveBeenCalledWith('conn-1', 3);
    await s.processor.process(s.job(CONNECTION_SETUP_SWEEP_JOB, {}));
    expect(s.setupService.sweep).toHaveBeenCalled();
    await s.processor.process(
      s.job(CONNECTION_TEMPLATE_SYNC_JOB, { connectionId: 'conn-2' }),
    );
    expect(s.templates.syncConnection).toHaveBeenCalledWith('conn-2');
  });

  it('fans the 6-hour sync out to every connected account', async () => {
    const s = setup();
    await s.processor.process(s.job(CONNECTION_TEMPLATE_SYNC_ALL_JOB, {}));
    expect(s.producer.requestTemplateSync.mock.calls).toEqual([
      ['conn-1', 0],
      ['conn-2', 0],
    ]);
  });
});

describe('WhatsappConnectionSetupScheduler', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('schedules the sweep every 2 minutes and the template sync every 6 hours', async () => {
    const queue = {
      upsertJobScheduler: jest.fn<Promise<unknown>, unknown[]>(() =>
        Promise.resolve({}),
      ),
    };
    await new WhatsappConnectionSetupScheduler(
      queue as unknown as SetupQueue,
    ).schedule();
    expect(
      queue.upsertJobScheduler.mock.calls.map((c) => [c[0], c[1]]),
    ).toEqual([
      ['whatsapp-health-sweep', { every: 60_000 }],
      ['whatsapp-connection-setup-sweep', { every: 120_000 }],
      ['whatsapp-connection-template-sync-6h', { every: 21_600_000 }],
    ]);
  });

  it('never throws when the queue is down', async () => {
    const queue = {
      upsertJobScheduler: jest.fn<Promise<unknown>, unknown[]>(() =>
        Promise.reject(new Error('down')),
      ),
    };
    await expect(
      new WhatsappConnectionSetupScheduler(
        queue as unknown as SetupQueue,
      ).schedule(),
    ).resolves.toBeUndefined();
  });
});
