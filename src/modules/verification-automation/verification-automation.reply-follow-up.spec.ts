import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  VerificationAutomationJobType,
  type VerificationAutomationJobPayload,
} from './verification-automation.constants';
import { VerificationAutomationProcessor } from './verification-automation.processor';

/** US-08-07 b and c: the worker hands each job to the follow-up service. */
function setup(handle: jest.Mock) {
  const processor = new VerificationAutomationProcessor(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { handle } as never,
  );
  return processor;
}

function job(
  name: VerificationAutomationJobType,
  reply?: VerificationAutomationJobPayload['reply'],
) {
  return {
    id: `job-${name}`,
    name,
    data: {
      verificationId: 'ver-1',
      orgId: 'org-1',
      scheduledAt: '2026-10-06T12:00:00.000Z',
      ...(reply ? { reply } : {}),
    },
  } as unknown as Job<VerificationAutomationJobPayload>;
}

describe('VerificationAutomationProcessor reply follow-ups', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [
      VerificationAutomationJobType.ACKNOWLEDGMENT,
      'acknowledgment',
      'confirmed',
    ],
    [VerificationAutomationJobType.UNRESOLVED_REPLY_NUDGE, 'nudge', undefined],
  ] as const)('passes %s to the service as %s', async (name, kind, intent) => {
    const handle = jest.fn().mockResolvedValue({ outcome: 'sent' });
    await setup(handle).process(
      job(name, {
        repliedAt: '2026-10-06T11:59:00.000Z',
        ...(intent ? { intent } : {}),
      }),
    );
    expect(handle).toHaveBeenCalledWith({
      kind,
      verificationId: 'ver-1',
      orgId: 'org-1',
      repliedAt: '2026-10-06T11:59:00.000Z',
      intent,
    });
  });

  it('never throws back to the queue, so a job is never retried', async () => {
    const handle = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(
      setup(handle).process(
        job(VerificationAutomationJobType.ACKNOWLEDGMENT, {
          repliedAt: '2026-10-06T11:59:00.000Z',
          intent: 'canceled',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('skips a job without its reply', async () => {
    const handle = jest.fn();
    await setup(handle).process(
      job(VerificationAutomationJobType.UNRESOLVED_REPLY_NUDGE),
    );
    expect(handle).not.toHaveBeenCalled();
  });
});
