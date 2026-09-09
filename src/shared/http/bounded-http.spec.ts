import {
  backoffDelay,
  boundedCall,
  NO_RETRY,
  RetryableProviderError,
  type RetryPolicy,
} from './bounded-http';

const policy: RetryPolicy = {
  attempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 800,
  totalDeadlineMs: 10_000,
};

/** Deterministic clock and sleep so the spec never actually waits. */
function harness(overrides: Partial<RetryPolicy> = {}) {
  const slept: number[] = [];
  let clock = 0;
  return {
    slept,
    options: {
      policy: { ...policy, ...overrides },
      random: () => 0.5,
      now: () => clock,
      sleep: (ms: number) => {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    },
  };
}

describe('backoffDelay', () => {
  it('draws from the whole window, so repeated waves do not re-collide', () => {
    expect(backoffDelay(1, policy, () => 0)).toBe(0);
    expect(backoffDelay(1, policy, () => 0.999)).toBe(99);
  });

  it('doubles the window per attempt up to the ceiling', () => {
    const full = (attempt: number) =>
      backoffDelay(attempt, policy, () => 0.999);
    expect([full(1), full(2), full(3), full(4), full(5)]).toEqual([
      99, 199, 399, 799, 799,
    ]);
  });
});

describe('boundedCall', () => {
  it('returns the first success without sleeping', async () => {
    const { slept, options } = harness();
    await expect(
      boundedCall(() => Promise.resolve('ok'), options),
    ).resolves.toBe('ok');
    expect(slept).toEqual([]);
  });

  it('retries only what the caller declared retryable', async () => {
    const { options } = harness();
    const call = jest
      .fn<Promise<string>, [number]>()
      .mockRejectedValueOnce(new RetryableProviderError('flaky'))
      .mockResolvedValueOnce('ok');
    await expect(boundedCall(call, options)).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('never repeats a call that failed for any other reason', async () => {
    const { options } = harness();
    // A checkout creation that may already have created an intention is not
    // safe to repeat, so anything but an explicit retryable error stops here.
    const call = jest.fn().mockRejectedValue(new Error('definitive'));
    await expect(boundedCall(call, options)).rejects.toThrow('definitive');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('stops at the attempt budget and rethrows the last failure', async () => {
    const { slept, options } = harness();
    const call = jest
      .fn()
      .mockRejectedValue(new RetryableProviderError('down'));
    await expect(boundedCall(call, options)).rejects.toThrow('down');
    expect(call).toHaveBeenCalledTimes(4);
    expect(slept).toHaveLength(3);
  });

  it('stops early when the next wait would pass the total deadline', async () => {
    const { slept, options } = harness({ totalDeadlineMs: 120 });
    const call = jest
      .fn()
      .mockRejectedValue(new RetryableProviderError('down'));
    await expect(boundedCall(call, options)).rejects.toThrow('down');
    expect(call).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([50]);
  });

  it('defaults to a single attempt', async () => {
    const call = jest
      .fn()
      .mockRejectedValue(new RetryableProviderError('down'));
    await expect(boundedCall(call, { policy: NO_RETRY })).rejects.toThrow(
      'down',
    );
    expect(call).toHaveBeenCalledTimes(1);
  });
});
