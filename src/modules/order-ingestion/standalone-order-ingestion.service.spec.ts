import {
  ManualOrderAcceptanceStateError,
  ManualOrderPayloadConflictError,
  type ManualOrderAcceptanceInput,
} from '../../infrastructure/database/repositories/manual-order-ingestion.repository';
import type { CanonicalOrderInput } from '../../shared/commerce/standalone-order-envelope';
import {
  importRowKey,
  namespaceIdempotencyKey,
  normalizeOrderReference,
} from './standalone-ingestion-keys';
import {
  StandaloneIngestionAcceptanceError,
  StandaloneIngestionConflictError,
  StandaloneIngestionDispatchError,
} from './standalone-order-ingestion.errors';
import { StandaloneOrderIngestionService } from './standalone-order-ingestion.service';

describe('StandaloneOrderIngestionService.acceptOne', () => {
  const ctx = {
    orgId: 'org-1',
    source: { id: 'int-1', platformStoreUrl: 'standalone:org-1' },
  };
  const input: CanonicalOrderInput = {
    externalOrderId: 'ref:1001',
    orderNumber: '#1001',
    customerPhone: '+201001234567',
    customerName: 'Customer',
    totalPrice: '50',
    currency: 'EGP',
    paymentMethod: 'cash on delivery',
  };
  const acceptance = {
    accept: jest.fn<
      Promise<{ eventId: string; order: { id: string }; duplicate: boolean }>,
      [ManualOrderAcceptanceInput]
    >(),
  };
  const dispatcher = { dispatchById: jest.fn<Promise<string>, [string]>() };
  const verifications = {
    findByOrderId: jest.fn<Promise<{ id: string } | undefined>, [string]>(),
  };
  let service: StandaloneOrderIngestionService;

  beforeEach(() => {
    jest.clearAllMocks();
    acceptance.accept.mockResolvedValue({
      eventId: 'event-1',
      order: { id: 'order-1' },
      duplicate: false,
    });
    dispatcher.dispatchById.mockResolvedValue('dispatched');
    verifications.findByOrderId.mockResolvedValue({ id: 'verification-1' });
    service = new StandaloneOrderIngestionService(
      acceptance as never,
      dispatcher as never,
      verifications as never,
    );
  });

  it('accepts and dispatches when not held', async () => {
    await expect(
      service.acceptOne(ctx, input, {
        channel: 'manual',
        idempotencyKey: 'key-00001',
      }),
    ).resolves.toEqual({
      orderId: 'order-1',
      eventId: 'event-1',
      verificationId: 'verification-1',
      duplicate: false,
      held: false,
    });
    const call = acceptance.accept.mock.calls[0][0];
    expect(call.event.idempotencyKey).toBe('key-00001');
    expect(call.event).not.toHaveProperty('hold');
    expect(call.event.rawPayload.ingestionType).toBe('manual');
    expect(call.order).toMatchObject({
      orgId: 'org-1',
      integrationId: 'int-1',
      totalPrice: '50.00',
      isTest: false,
    });
    expect(dispatcher.dispatchById).toHaveBeenCalledWith('event-1');
  });

  it('persists a held order without dispatching or reading a verification', async () => {
    await expect(
      service.acceptOne(ctx, input, {
        channel: 'bulk_import',
        idempotencyKey: importRowKey('batch-1', 7),
        hold: { groupId: 'batch-1' },
        envelopeExtras: { importBatchId: 'batch-1', importRowNumber: 7 },
      }),
    ).resolves.toEqual({
      orderId: 'order-1',
      eventId: 'event-1',
      duplicate: false,
      held: true,
    });
    const call = acceptance.accept.mock.calls[0][0];
    expect(call.event.hold).toEqual({ groupId: 'batch-1' });
    expect(call.event.idempotencyKey).toBe('import:batch-1:7');
    expect(call.event.rawPayload).toMatchObject({
      ingestionType: 'bulk_import',
      importBatchId: 'batch-1',
      importRowNumber: 7,
    });
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
    expect(verifications.findByOrderId).not.toHaveBeenCalled();
  });

  it.each(['not_claimed', 'failed'])(
    'reports a %s dispatch as a dispatch failure',
    async (outcome) => {
      dispatcher.dispatchById.mockResolvedValue(outcome);
      await expect(
        service.acceptOne(ctx, input, {
          channel: 'manual',
          idempotencyKey: 'key-00001',
        }),
      ).rejects.toBeInstanceOf(StandaloneIngestionDispatchError);
    },
  );

  it('reports a thrown dispatch as a dispatch failure', async () => {
    dispatcher.dispatchById.mockRejectedValue(new Error('redis down'));
    await expect(
      service.acceptOne(ctx, input, {
        channel: 'manual',
        idempotencyKey: 'key-00001',
      }),
    ).rejects.toBeInstanceOf(StandaloneIngestionDispatchError);
  });

  it('maps a payload conflict and never dispatches', async () => {
    acceptance.accept.mockRejectedValue(new ManualOrderPayloadConflictError());
    await expect(
      service.acceptOne(ctx, input, {
        channel: 'manual',
        idempotencyKey: 'key-00001',
      }),
    ).rejects.toBeInstanceOf(StandaloneIngestionConflictError);
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  });

  it.each([
    new ManualOrderAcceptanceStateError('not persisted'),
    new Error('connection reset'),
  ])('maps an acceptance failure (%s)', async (error) => {
    acceptance.accept.mockRejectedValue(error);
    await expect(
      service.acceptOne(ctx, input, {
        channel: 'manual',
        idempotencyKey: 'key-00001',
      }),
    ).rejects.toBeInstanceOf(StandaloneIngestionAcceptanceError);
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  });

  it('still answers when the verification read fails', async () => {
    verifications.findByOrderId.mockRejectedValue(new Error('read failed'));
    await expect(
      service.acceptOne(ctx, input, {
        channel: 'manual',
        idempotencyKey: 'key-00001',
      }),
    ).resolves.toEqual({
      orderId: 'order-1',
      eventId: 'event-1',
      duplicate: false,
      held: false,
    });
  });
});

describe('Standalone ingestion keys', () => {
  it('keeps manual keys unchanged and namespaces import rows', () => {
    expect(namespaceIdempotencyKey('manual', 'abc-12345')).toBe('abc-12345');
    expect(
      namespaceIdempotencyKey('bulk_import', importRowKey('batch-1', 12)),
    ).toBe('import:batch-1:12');
  });

  it.each([
    ['1001', 'ref:1001'],
    ['#1001', 'ref:1001'],
    ['  # 10 01 ', 'ref:1001'],
    ['##ABC 12', 'ref:abc12'],
    ['ORD-7\t8', 'ref:ord-78'],
    ['طلب 3', 'ref:طلب3'],
    ['   ', null],
    ['#', null],
  ])('normalizes order reference %j to %j', (raw, expected) => {
    expect(normalizeOrderReference(raw)).toBe(expected);
  });
});
