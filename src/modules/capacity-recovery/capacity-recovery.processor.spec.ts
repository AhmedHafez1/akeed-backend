import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { USAGE_ALERTS_CONFIG } from '../../shared/config/usage-alerts.config';
import {
  CAPACITY_RECOVERY_RECOVER_JOB,
  CAPACITY_RECOVERY_SWEEP_JOB,
  capacityRecoveryContinuationDedupeId,
  capacityRecoveryDedupeId,
} from './capacity-recovery.constants';
import { CapacityRecoveryProcessor } from './capacity-recovery.processor';
import { CapacityRecoveryProducer } from './capacity-recovery.producer';
import type { CapacityRecoveryService } from './capacity-recovery.service';

const CURSOR = { createdAt: '2026-10-22T10:00:00.000Z', id: 'ver-500' };

function setup(result: { more: boolean; cursor: typeof CURSOR | null }) {
  const settings = { recoveryEnabled: true };
  const config = {
    get: (key: string) => (key === USAGE_ALERTS_CONFIG ? settings : undefined),
  } as unknown as ConfigService;
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  // The real producer over a fake queue, so the deduplication ids are checked.
  const producer = new CapacityRecoveryProducer(queue as never, config);
  const recovery = { recover: jest.fn().mockResolvedValue(result) };
  const verificationsRepo = {
    listOrgsWithBlocked: jest.fn().mockResolvedValue(['org-1', 'org-2']),
  };
  const processor = new CapacityRecoveryProcessor(
    recovery as unknown as CapacityRecoveryService,
    producer,
    verificationsRepo as unknown as VerificationsRepository,
    config,
  );
  return { processor, queue, recovery, verificationsRepo };
}

function recoverJob(data: Record<string, unknown>) {
  return { id: 'job-7', name: CAPACITY_RECOVERY_RECOVER_JOB, data } as Job;
}

describe('CapacityRecoveryProcessor', () => {
  it('continues under its own deduplication id, from the cursor', async () => {
    const { processor, queue } = setup({ more: true, cursor: CURSOR });

    await processor.process(recoverJob({ orgId: 'org-1', trigger: 'sweep' }));

    expect(capacityRecoveryContinuationDedupeId('org-1', 'job-7')).not.toBe(
      capacityRecoveryDedupeId('org-1'),
    );
    expect(queue.add).toHaveBeenCalledWith(
      CAPACITY_RECOVERY_RECOVER_JOB,
      { orgId: 'org-1', trigger: 'continuation', after: CURSOR },
      expect.objectContaining({
        deduplication: {
          id: capacityRecoveryContinuationDedupeId('org-1', 'job-7'),
        },
      }),
    );
  });

  it('passes a continuation cursor to the run', async () => {
    const { processor, recovery } = setup({ more: false, cursor: CURSOR });

    await processor.process(
      recoverJob({ orgId: 'org-1', trigger: 'continuation', after: CURSOR }),
    );

    expect(recovery.recover).toHaveBeenCalledWith(
      'org-1',
      expect.any(Date),
      CURSOR,
    );
  });

  it('stops when the run has nothing more', async () => {
    const { processor, queue } = setup({ more: false, cursor: CURSOR });

    await processor.process(recoverJob({ orgId: 'org-1', trigger: 'sweep' }));

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('sweeps orgs with blocked orders or stranded handoffs', async () => {
    const { processor, queue, verificationsRepo } = setup({
      more: false,
      cursor: null,
    });

    await processor.process({
      id: 'sweep-1',
      name: CAPACITY_RECOVERY_SWEEP_JOB,
      data: {},
    } as Job);

    expect(verificationsRepo.listOrgsWithBlocked).toHaveBeenCalledWith(
      500,
      expect.any(String),
    );
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      CAPACITY_RECOVERY_RECOVER_JOB,
      { orgId: 'org-2', trigger: 'sweep' },
      expect.objectContaining({
        deduplication: { id: capacityRecoveryDedupeId('org-2') },
      }),
    );
  });
});
