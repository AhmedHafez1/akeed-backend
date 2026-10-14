import { VerificationAutomationProducer } from './verification-automation.producer';

function job(state: string) {
  return {
    getState: jest.fn().mockResolvedValue(state),
    remove: jest.fn().mockResolvedValue(undefined),
  };
}

describe('VerificationAutomationProducer.cancelPendingReminders', () => {
  const params = { verificationId: 'v1', orgId: 'org-1' };

  it('removes the reminder and the escalation while they wait', async () => {
    const followUp = job('delayed');
    const escalation = job('waiting');
    const queue = {
      getJob: jest.fn((id: string) =>
        Promise.resolve(
          id === 'verification-v1-follow-up-1' ? followUp : escalation,
        ),
      ),
    };
    const producer = new VerificationAutomationProducer(queue as never);

    await expect(producer.cancelPendingReminders(params)).resolves.toBe(2);

    expect(queue.getJob).toHaveBeenCalledWith('verification-v1-follow-up-1');
    expect(queue.getJob).toHaveBeenCalledWith('verification-v1-no-reply');
    expect(followUp.remove).toHaveBeenCalled();
    expect(escalation.remove).toHaveBeenCalled();
  });

  it('leaves running and finished jobs, and missing ones, alone', async () => {
    const running = job('active');
    const queue = {
      getJob: jest.fn((id: string) =>
        Promise.resolve(
          id === 'verification-v1-follow-up-1' ? running : undefined,
        ),
      ),
    };
    const producer = new VerificationAutomationProducer(queue as never);

    await expect(producer.cancelPendingReminders(params)).resolves.toBe(0);

    expect(running.remove).not.toHaveBeenCalled();
  });

  it('never throws on a queue error and still tries the other job', async () => {
    const escalation = job('delayed');
    const queue = {
      getJob: jest.fn((id: string) =>
        id === 'verification-v1-follow-up-1'
          ? Promise.reject(new Error('redis unavailable'))
          : Promise.resolve(escalation),
      ),
    };
    const producer = new VerificationAutomationProducer(queue as never);

    await expect(producer.cancelPendingReminders(params)).resolves.toBe(1);

    expect(escalation.remove).toHaveBeenCalled();
  });

  it('touches no other job of the verification', async () => {
    const queue = { getJob: jest.fn().mockResolvedValue(undefined) };
    const producer = new VerificationAutomationProducer(queue as never);

    await producer.cancelPendingReminders(params);

    expect(queue.getJob.mock.calls.map(([id]) => id as string)).toEqual([
      'verification-v1-follow-up-1',
      'verification-v1-no-reply',
    ]);
  });
});
