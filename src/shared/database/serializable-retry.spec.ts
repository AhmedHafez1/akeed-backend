import {
  databaseErrorCode,
  isSerializationFailure,
  withSerializableRetry,
} from './serializable-retry';

function pgError(code: string, nested = false): Error {
  const inner = Object.assign(new Error('database'), { code });
  return nested ? Object.assign(new Error('wrapped'), { cause: inner }) : inner;
}

describe('databaseErrorCode', () => {
  it('reads the code off the error', () => {
    expect(databaseErrorCode(pgError('40001'))).toBe('40001');
  });

  it('walks the cause chain, because drivers wrap the original', () => {
    expect(databaseErrorCode(pgError('40P01', true))).toBe('40P01');
  });

  it.each([undefined, null, 'string', new Error('plain')])(
    'reports no code for %p',
    (value) => {
      expect(databaseErrorCode(value)).toBeUndefined();
    },
  );
});

describe('isSerializationFailure', () => {
  it.each(['40001', '40P01'])('recognises %s', (code) => {
    expect(isSerializationFailure(pgError(code))).toBe(true);
  });

  it.each(['23505', '23514', '08006'])('does not retry %s', (code) => {
    // A unique violation, a check violation and a connection error all mean
    // something a repeat would not fix.
    expect(isSerializationFailure(pgError(code))).toBe(false);
  });
});

describe('withSerializableRetry', () => {
  it('returns the first success', async () => {
    const work = jest.fn().mockResolvedValue('ok');
    await expect(withSerializableRetry(work)).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('reruns the whole transaction after a serialization failure', async () => {
    const work = jest
      .fn()
      .mockRejectedValueOnce(pgError('40001'))
      .mockResolvedValueOnce('ok');
    await expect(withSerializableRetry(work)).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('never repeats anything else', async () => {
    const work = jest.fn().mockRejectedValue(pgError('23505'));
    await expect(withSerializableRetry(work)).rejects.toMatchObject({
      code: '23505',
    });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('gives up rather than grinding at sustained contention', async () => {
    const work = jest.fn().mockRejectedValue(pgError('40001'));
    await expect(withSerializableRetry(work)).rejects.toMatchObject({
      code: '40001',
    });
    expect(work).toHaveBeenCalledTimes(3);
  });
});
