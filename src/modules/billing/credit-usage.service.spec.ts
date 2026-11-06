import {
  creditUsageTimeZone,
  CreditUsageService,
} from './credit-usage.service';
import type { CreditUsageRepository } from '../../infrastructure/database/repositories/credit-usage.repository';

describe('credit usage read boundary', () => {
  it('uses UTC by default and canonicalizes a valid IANA zone', () => {
    expect(creditUsageTimeZone(undefined)).toBe('UTC');
    expect(creditUsageTimeZone('Africa/Cairo')).toBe('Africa/Cairo');
  });
  it.each(['', 'not-a-zone', '+01:00', ['UTC'], {}, null, 'x'.repeat(101)])(
    'rejects invalid zones without echoing their value',
    (input) => {
      expect(() => creditUsageTimeZone(input)).toThrow(
        'A valid timeZone is required.',
      );
    },
  );
  it('scopes the read and passes one instant', async () => {
    const read = jest.fn().mockResolvedValue({ usedThisMonth: 0 });
    const service = new CreditUsageService({
      read,
    } as unknown as CreditUsageRepository);
    await service.read('tenant-a', 'UTC');
    expect(read).toHaveBeenCalledWith('tenant-a', 'UTC', expect.any(String));
  });
  it('returns unavailable when historical billing evidence is incomplete', async () => {
    const service = new CreditUsageService({
      read: jest.fn().mockResolvedValue(null),
    } as unknown as CreditUsageRepository);
    await expect(service.read('tenant-a')).rejects.toMatchObject({
      status: 503,
    });
  });
});
