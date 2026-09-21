import {
  ManualOrderAcceptanceStateError,
  ManualOrderPayloadConflictError,
} from '../../infrastructure/database/repositories/manual-order-ingestion.repository';
import { StandaloneOrderIngestionService } from './standalone-order-ingestion.service';
import {
  StandaloneIngestionAcceptanceError,
  StandaloneIngestionConflictError,
} from './standalone-order-ingestion.errors';
import type { AcceptManyInput } from './standalone-order-ingestion.types';

const ctx = {
  orgId: 'org-1',
  source: { id: 'int-1', platformStoreUrl: 'store-1.akeed.local' },
};
const HOLD = { groupId: 'batch-1' } as const;

function input(rowNumber: number): AcceptManyInput {
  return {
    idempotencyKey: `batch-1:${rowNumber}`,
    order: {
      externalOrderId: `ref:${1000 + rowNumber}`,
      orderNumber: `#${1000 + rowNumber}`,
      customerPhone: '+201012345678',
      customerName: 'Ahmed Ali',
      totalPrice: '750.00',
      currency: 'EGP',
      paymentMethod: 'cash_on_delivery',
    },
    envelopeExtras: { importBatchId: 'batch-1', importRowNumber: rowNumber },
  };
}

function setup() {
  const acceptance = { accept: jest.fn(), acceptMany: jest.fn() };
  const dispatcher = { dispatchById: jest.fn() };
  const verificationsRepo = { findByOrderId: jest.fn() };
  const service = new StandaloneOrderIngestionService(
    acceptance as never,
    dispatcher as never,
    verificationsRepo as never,
    {} as never,
  );
  return { service, acceptance, dispatcher };
}

describe('StandaloneOrderIngestionService.acceptMany', () => {
  it('holds every row and never dispatches', async () => {
    // Epic invariant 1: nothing reaches a customer before POST /start.
    const { service, acceptance, dispatcher } = setup();
    acceptance.acceptMany.mockResolvedValue([
      {
        status: 'accepted',
        eventId: 'event-1',
        order: { id: 'order-1' },
        duplicate: false,
      },
    ]);

    const results = await service.acceptMany(ctx, [input(1)], {
      channel: 'bulk_import',
      hold: HOLD,
    });

    expect(results).toEqual([
      {
        status: 'accepted',
        orderId: 'order-1',
        eventId: 'event-1',
        duplicate: false,
      },
    ]);
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
    expect(acceptance.acceptMany).toHaveBeenCalledWith(expect.anything(), {
      hold: HOLD,
    });
  });

  it('namespaces each row key and builds the bulk envelope', async () => {
    const { service, acceptance } = setup();
    acceptance.acceptMany.mockResolvedValue([
      {
        status: 'accepted',
        eventId: 'e1',
        order: { id: 'o1' },
        duplicate: false,
      },
    ]);

    await service.acceptMany(ctx, [input(7)], {
      channel: 'bulk_import',
      hold: HOLD,
    });

    const [rows] = acceptance.acceptMany.mock.calls[0] as [
      Array<{
        event: { idempotencyKey: string; rawPayload: Record<string, unknown> };
        order: { externalOrderId: string };
      }>,
    ];
    expect(rows[0].event.idempotencyKey).toBe('import:batch-1:7');
    expect(rows[0].event.rawPayload).toMatchObject({
      ingestionType: 'bulk_import',
      schemaVersion: 1,
      importBatchId: 'batch-1',
      importRowNumber: 7,
    });
    expect(rows[0].order.externalOrderId).toBe('ref:1007');
  });

  it('reports the rows that lost a reference race, in input order', async () => {
    const { service, acceptance } = setup();
    acceptance.acceptMany.mockResolvedValue([
      {
        status: 'accepted',
        eventId: 'e1',
        order: { id: 'o1' },
        duplicate: false,
      },
      { status: 'already_imported' },
      {
        status: 'accepted',
        eventId: 'e3',
        order: { id: 'o3' },
        duplicate: true,
      },
    ]);

    const results = await service.acceptMany(
      ctx,
      [input(1), input(2), input(3)],
      { channel: 'bulk_import', hold: HOLD },
    );

    expect(results.map((result) => result.status)).toEqual([
      'accepted',
      'already_imported',
      'accepted',
    ]);
    expect(results[2]).toMatchObject({ duplicate: true });
  });

  it('maps a fingerprint clash to the shared conflict error', async () => {
    const { service, acceptance } = setup();
    acceptance.acceptMany.mockRejectedValue(
      new ManualOrderPayloadConflictError(),
    );

    await expect(
      service.acceptMany(ctx, [input(1)], {
        channel: 'bulk_import',
        hold: HOLD,
      }),
    ).rejects.toBeInstanceOf(StandaloneIngestionConflictError);
  });

  it.each([
    ['an acceptance state breach', new ManualOrderAcceptanceStateError('bad')],
    ['a database failure', new Error('connection reset')],
  ])('maps %s to a retryable acceptance error', async (_label, error) => {
    const { service, acceptance } = setup();
    acceptance.acceptMany.mockRejectedValue(error);

    await expect(
      service.acceptMany(ctx, [input(1)], {
        channel: 'bulk_import',
        hold: HOLD,
      }),
    ).rejects.toBeInstanceOf(StandaloneIngestionAcceptanceError);
  });

  it('accepts an empty batch without calling the repository', async () => {
    const { service, acceptance } = setup();
    acceptance.acceptMany.mockResolvedValue([]);

    await expect(
      service.acceptMany(ctx, [], { channel: 'bulk_import', hold: HOLD }),
    ).resolves.toEqual([]);
  });
});
