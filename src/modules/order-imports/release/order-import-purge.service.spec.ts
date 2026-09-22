import { Logger } from '@nestjs/common';
import {
  ORDER_IMPORT_PURGE_CHUNK,
  OrderImportPurgeService,
} from './order-import-purge.service';

const NOW = new Date('2026-09-22T03:00:00.000Z');
const DAY = 24 * 3_600_000;

function setup(drafts: number[], rows: number[]) {
  const repository = {
    deleteExpiredDrafts: jest.fn(() => Promise.resolve(drafts.shift() ?? 0)),
    purgeCommittedRows: jest.fn(() => Promise.resolve(rows.shift() ?? 0)),
  };
  return {
    repository,
    service: new OrderImportPurgeService(repository as never),
  };
}

describe('OrderImportPurgeService', () => {
  let log: jest.SpyInstance<
    void,
    [message: unknown, ...optionalParams: unknown[]]
  >;
  beforeEach(() => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  it('drains full chunks until a short one, with a 90-day cutoff', async () => {
    const { service, repository } = setup(
      [ORDER_IMPORT_PURGE_CHUNK, 3],
      [ORDER_IMPORT_PURGE_CHUNK, ORDER_IMPORT_PURGE_CHUNK, 0],
    );

    const result = await service.run(NOW);

    expect(result).toEqual({
      draftsDeleted: ORDER_IMPORT_PURGE_CHUNK + 3,
      rowsPurged: 2 * ORDER_IMPORT_PURGE_CHUNK,
    });
    expect(repository.deleteExpiredDrafts).toHaveBeenCalledTimes(2);
    expect(repository.deleteExpiredDrafts).toHaveBeenCalledWith(
      NOW,
      ORDER_IMPORT_PURGE_CHUNK,
    );
    expect(repository.purgeCommittedRows).toHaveBeenCalledTimes(3);
    expect(repository.purgeCommittedRows).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 90 * DAY),
      1_000,
    );
  });

  it('is a single cheap pass when nothing is due, and logs counts only', async () => {
    const { service, repository } = setup([], []);

    await expect(service.run(NOW)).resolves.toEqual({
      draftsDeleted: 0,
      rowsPurged: 0,
    });
    expect(repository.purgeCommittedRows).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0] as string) as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({
      action: 'order-import-purge',
      outcome: 'success',
      draftsDeleted: 0,
      rowsPurged: 0,
    });
    expect(Object.keys(line).sort()).toEqual(
      [
        'action',
        'app',
        'draftsDeleted',
        'durationMs',
        'env',
        'module',
        'outcome',
        'rowsPurged',
      ].sort(),
    );
  });
});
