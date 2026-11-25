import { Test } from '@nestjs/testing';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { PublicStatsController } from './public-stats.controller';
import {
  PUBLIC_STATS_CACHE_TTL_MS,
  PublicStatsService,
} from './public-stats.service';

describe('PublicStatsService', () => {
  const now = Date.parse('2026-11-25T10:00:00.000Z');

  function setup() {
    const repository = {
      countCustomerConfirmedProductionOrders: jest.fn(() =>
        Promise.resolve(1234),
      ),
    };
    const service = new PublicStatsService(
      repository as unknown as VerificationsRepository,
    );
    return { repository, service };
  }

  it('returns the confirmed-orders total with the time it was read', async () => {
    const { service } = setup();
    await expect(service.getStats(now)).resolves.toEqual({
      confirmed_orders_total: 1234,
      as_of: '2026-11-25T10:00:00.000Z',
    });
  });

  it('serves the cached value until it expires', async () => {
    const { repository, service } = setup();
    await service.getStats(now);
    await service.getStats(now + PUBLIC_STATS_CACHE_TTL_MS - 1);
    expect(
      repository.countCustomerConfirmedProductionOrders,
    ).toHaveBeenCalledTimes(1);

    repository.countCustomerConfirmedProductionOrders.mockResolvedValueOnce(
      1300,
    );
    await expect(
      service.getStats(now + PUBLIC_STATS_CACHE_TTL_MS),
    ).resolves.toEqual(
      expect.objectContaining({ confirmed_orders_total: 1300 }),
    );
  });

  it('shares one query between concurrent misses', async () => {
    const { repository, service } = setup();
    await Promise.all([service.getStats(now), service.getStats(now)]);
    expect(
      repository.countCustomerConfirmedProductionOrders,
    ).toHaveBeenCalledTimes(1);
  });

  it('propagates a failure and does not cache it', async () => {
    const { repository, service } = setup();
    repository.countCustomerConfirmedProductionOrders.mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(service.getStats(now)).rejects.toThrow('db down');
    await expect(service.getStats(now)).resolves.toEqual(
      expect.objectContaining({ confirmed_orders_total: 1234 }),
    );
  });
});

describe('PublicStatsController', () => {
  it('answers with the service stats', async () => {
    const stats = {
      confirmed_orders_total: 7,
      as_of: '2026-11-25T10:00:00.000Z',
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicStatsController],
      providers: [
        {
          provide: PublicStatsService,
          useValue: { getStats: jest.fn(() => Promise.resolve(stats)) },
        },
      ],
    }).compile();

    await expect(
      moduleRef.get(PublicStatsController).getStats(),
    ).resolves.toEqual(stats);
  });
});
