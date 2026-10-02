import {
  ManualOrderAcceptanceStateError,
  ManualOrderIdentityConflictError,
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
  StandaloneIngestionExternalIdConflictError,
} from './standalone-order-ingestion.errors';
import { StandaloneOrderIngestionService } from './standalone-order-ingestion.service';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { MANUAL_ORDER_READINESS_CODES } from './standalone-readiness-gate';
import { MANUAL_ORDER_SOURCE_CODES } from './standalone-source-resolver';

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
      Promise<{
        eventId: string;
        order: { id: string };
        duplicate: boolean;
        replay?: 'event_key' | 'external_id';
      }>,
      [ManualOrderAcceptanceInput]
    >(),
  };
  const dispatcher = {
    dispatchById: jest.fn<Promise<string>, [string]>(),
    isAlreadyDispatched: jest.fn<Promise<boolean>, [string]>(),
  };
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
    dispatcher.isAlreadyDispatched.mockResolvedValue(false);
    verifications.findByOrderId.mockResolvedValue({ id: 'verification-1' });
    service = new StandaloneOrderIngestionService(
      acceptance as never,
      dispatcher as never,
      verifications as never,
      {} as never,
      {} as never,
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

  describe('replays (US-05-03)', () => {
    let logged: jest.SpyInstance;
    let errors: jest.SpyInstance;
    const acceptLogs = () =>
      (logged.mock.calls as [string][]).map(
        ([entry]) => JSON.parse(entry) as Record<string, unknown>,
      );

    beforeEach(() => {
      logged = jest
        .spyOn(service['logger'], 'log')
        .mockImplementation(() => undefined);
      errors = jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => undefined);
    });

    it('answers an external-id replay without dispatching anything', async () => {
      acceptance.accept.mockResolvedValue({
        eventId: 'event-of-first-request',
        order: { id: 'order-1' },
        duplicate: true,
        replay: 'external_id',
      });

      await expect(
        service.acceptOne(ctx, input, {
          channel: 'api',
          idempotencyKey: 'a-new-key-1',
        }),
      ).resolves.toEqual({
        orderId: 'order-1',
        eventId: 'event-of-first-request',
        verificationId: 'verification-1',
        duplicate: true,
        held: false,
      });
      // Not even the existing order's own event: it may be a held or
      // withdrawn import, and this request owns no event to send.
      expect(dispatcher.dispatchById).not.toHaveBeenCalled();
      expect(verifications.findByOrderId).toHaveBeenCalledWith('order-1');
      expect(acceptLogs()).toEqual([
        expect.objectContaining({
          action: 'api-order-accept',
          outcome: 'success',
          duplicate: true,
          replay: 'external_id',
        }),
      ]);
    });

    it('answers an external-id replay of an order that has no verification yet', async () => {
      acceptance.accept.mockResolvedValue({
        eventId: 'held-import-event',
        order: { id: 'order-1' },
        duplicate: true,
        replay: 'external_id',
      });
      verifications.findByOrderId.mockResolvedValue(undefined);

      await expect(
        service.acceptOne(ctx, input, {
          channel: 'api',
          idempotencyKey: 'a-new-key-1',
        }),
      ).resolves.toEqual({
        orderId: 'order-1',
        eventId: 'held-import-event',
        duplicate: true,
        held: false,
      });
      expect(dispatcher.dispatchById).not.toHaveBeenCalled();
    });

    it('maps a differing order under the same identity and never dispatches', async () => {
      acceptance.accept.mockRejectedValue(
        new ManualOrderIdentityConflictError(),
      );

      await expect(
        service.acceptOne(ctx, input, {
          channel: 'api',
          idempotencyKey: 'a-new-key-1',
        }),
      ).rejects.toBeInstanceOf(StandaloneIngestionExternalIdConflictError);
      expect(dispatcher.dispatchById).not.toHaveBeenCalled();
      expect(verifications.findByOrderId).not.toHaveBeenCalled();
      // A refusal of the caller's content, not a fault of ours.
      expect(errors).not.toHaveBeenCalled();
    });

    it('still re-dispatches the same event on a same-key replay', async () => {
      acceptance.accept.mockResolvedValue({
        eventId: 'event-1',
        order: { id: 'order-1' },
        duplicate: true,
        replay: 'event_key',
      });

      await expect(
        service.acceptOne(ctx, input, {
          channel: 'api',
          idempotencyKey: 'key-00001',
        }),
      ).resolves.toMatchObject({ orderId: 'order-1', duplicate: true });
      expect(dispatcher.dispatchById).toHaveBeenCalledWith('event-1');
      expect(acceptLogs()).toEqual([
        expect.objectContaining({ duplicate: true, replay: 'event_key' }),
      ]);
    });

    it.each([true, false])(
      'answers success when the event was already dispatched (duplicate: %s)',
      async (duplicate) => {
        // A retry after a lost response, or the recovery sweep winning the
        // claim between the commit and this dispatch.
        acceptance.accept.mockResolvedValue({
          eventId: 'event-1',
          order: { id: 'order-1' },
          duplicate,
          ...(duplicate ? { replay: 'event_key' as const } : {}),
        });
        dispatcher.dispatchById.mockResolvedValue('not_claimed');
        dispatcher.isAlreadyDispatched.mockResolvedValue(true);

        await expect(
          service.acceptOne(ctx, input, {
            channel: 'manual',
            idempotencyKey: 'key-00001',
          }),
        ).resolves.toEqual({
          orderId: 'order-1',
          eventId: 'event-1',
          verificationId: 'verification-1',
          duplicate,
          held: false,
        });
        expect(dispatcher.isAlreadyDispatched).toHaveBeenCalledWith('event-1');
        expect(errors).not.toHaveBeenCalled();
      },
    );

    it('keeps the dispatch failure when the event state cannot be read', async () => {
      dispatcher.dispatchById.mockResolvedValue('not_claimed');
      dispatcher.isAlreadyDispatched.mockRejectedValue(
        new Error('connection reset'),
      );
      await expect(
        service.acceptOne(ctx, input, {
          channel: 'manual',
          idempotencyKey: 'key-00001',
        }),
      ).rejects.toBeInstanceOf(StandaloneIngestionDispatchError);
    });

    it('never asks whether a failed dispatch was already dispatched', async () => {
      dispatcher.dispatchById.mockResolvedValue('failed');
      dispatcher.isAlreadyDispatched.mockResolvedValue(true);
      await expect(
        service.acceptOne(ctx, input, {
          channel: 'manual',
          idempotencyKey: 'key-00001',
        }),
      ).rejects.toBeInstanceOf(StandaloneIngestionDispatchError);
      expect(dispatcher.isAlreadyDispatched).not.toHaveBeenCalled();
    });

    it('logs no replay kind for a new order', async () => {
      await service.acceptOne(ctx, input, {
        channel: 'manual',
        idempotencyKey: 'key-00001',
      });
      expect(acceptLogs()).toHaveLength(1);
      expect(acceptLogs()[0]).not.toHaveProperty('replay');
      // Nothing of the order itself is logged.
      expect(JSON.stringify(acceptLogs())).not.toContain('+201001234567');
    });
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

describe('StandaloneOrderIngestionService.submitOne', () => {
  const source = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'standalone',
    platformStoreUrl: 'standalone:org-1',
  };
  const input: CanonicalOrderInput = {
    externalOrderId: 'ref:1001',
    orderNumber: '#1001',
    customerPhone: '+201001234567',
    customerName: 'Customer',
    totalPrice: '50',
    currency: 'EGP',
    paymentMethod: 'cash_on_delivery',
  };
  const user: AuthenticatedUser = {
    userId: 'user-1',
    orgId: 'org-1',
    role: 'owner',
    source: 'supabase',
  };
  const apiKey = {
    orgId: 'org-1',
    integrationId: 'int-1',
    keyId: 'key-1',
    prefix: 'ak_live_ab12cd34',
  };
  const codes = {
    source: MANUAL_ORDER_SOURCE_CODES,
    readiness: MANUAL_ORDER_READINESS_CODES,
  };
  const acceptance = {
    accept: jest.fn<
      Promise<{ eventId: string; order: { id: string }; duplicate: boolean }>,
      [ManualOrderAcceptanceInput]
    >(),
    isKnown: jest.fn<Promise<boolean>, [ManualOrderAcceptanceInput]>(),
  };
  const dispatcher = { dispatchById: jest.fn<Promise<string>, [string]>() };
  const verifications = { findByOrderId: jest.fn() };
  const resolver = {
    resolveWritable: jest.fn(),
    resolveForIntegration: jest.fn(),
  };
  const readiness = { evaluate: jest.fn() };
  let service: StandaloneOrderIngestionService;

  beforeEach(() => {
    jest.clearAllMocks();
    acceptance.accept.mockResolvedValue({
      eventId: 'event-1',
      order: { id: 'order-1' },
      duplicate: false,
    });
    acceptance.isKnown.mockResolvedValue(false);
    dispatcher.dispatchById.mockResolvedValue('dispatched');
    verifications.findByOrderId.mockResolvedValue({ id: 'verification-1' });
    resolver.resolveWritable.mockResolvedValue(source);
    resolver.resolveForIntegration.mockResolvedValue(source);
    readiness.evaluate.mockResolvedValue({ ready: true, blockers: [] });
    service = new StandaloneOrderIngestionService(
      acceptance as never,
      dispatcher as never,
      verifications as never,
      resolver as never,
      readiness as never,
    );
  });

  it('resolves a session user by role, checks readiness for one send, then accepts', async () => {
    await expect(
      service.submitOne(user, input, {
        channel: 'manual',
        idempotencyKey: 'key-00001',
        codes,
      }),
    ).resolves.toEqual({
      orderId: 'order-1',
      eventId: 'event-1',
      verificationId: 'verification-1',
      duplicate: false,
      held: false,
    });

    expect(resolver.resolveWritable).toHaveBeenCalledWith(user, codes.source);
    expect(resolver.resolveForIntegration).not.toHaveBeenCalled();
    expect(readiness.evaluate).toHaveBeenCalledWith(source, { required: 1 });
    const resolved = resolver.resolveWritable.mock.invocationCallOrder[0];
    const evaluated = readiness.evaluate.mock.invocationCallOrder[0];
    const accepted = acceptance.accept.mock.invocationCallOrder[0];
    expect(resolved).toBeLessThan(evaluated);
    expect(evaluated).toBeLessThan(accepted);
    expect(acceptance.accept.mock.calls[0][0].event).toMatchObject({
      orgId: 'org-1',
      integrationId: 'int-1',
      storeDomain: 'standalone:org-1',
      idempotencyKey: 'key-00001',
    });
  });

  it('resolves an integration principal by its integration, with no role', async () => {
    await service.submitOne(apiKey, input, {
      channel: 'api',
      idempotencyKey: 'order-1001',
      codes,
    });

    expect(resolver.resolveForIntegration).toHaveBeenCalledWith(
      'org-1',
      'int-1',
      codes.source,
    );
    expect(resolver.resolveWritable).not.toHaveBeenCalled();
    expect(readiness.evaluate).toHaveBeenCalledWith(source, { required: 1 });
    const call = acceptance.accept.mock.calls[0][0];
    expect(call.event).toMatchObject({
      orgId: 'org-1',
      integrationId: 'int-1',
      storeDomain: 'standalone:org-1',
      idempotencyKey: 'api:order-1001',
    });
    expect(call.event.rawPayload.ingestionType).toBe('api');
    // The command never learns which credential produced the order.
    expect(JSON.stringify(call)).not.toContain('key-1');
    expect(JSON.stringify(call)).not.toContain('ak_live_ab12cd34');
  });

  it('accepts into the resolved source, never the one the principal names', async () => {
    resolver.resolveForIntegration.mockResolvedValue({
      ...source,
      id: 'int-resolved',
      platformStoreUrl: 'standalone:resolved',
    });
    await service.submitOne(apiKey, input, {
      channel: 'api',
      idempotencyKey: 'order-1001',
      codes,
    });
    expect(acceptance.accept.mock.calls[0][0].event).toMatchObject({
      integrationId: 'int-resolved',
      storeDomain: 'standalone:resolved',
    });
  });

  it('accepts nothing when the source cannot be resolved', async () => {
    const refusal = new Error('source refused');
    resolver.resolveWritable.mockRejectedValue(refusal);
    await expect(
      service.submitOne(user, input, {
        channel: 'manual',
        idempotencyKey: 'key-00001',
        codes,
      }),
    ).rejects.toBe(refusal);
    expect(readiness.evaluate).not.toHaveBeenCalled();
    expect(acceptance.accept).not.toHaveBeenCalled();
  });

  it('accepts nothing while the source is not ready to send', async () => {
    readiness.evaluate.mockResolvedValue({
      ready: false,
      blockers: [{ kind: 'auto_verify_disabled' }],
    });
    await expect(
      service.submitOne(apiKey, input, {
        channel: 'api',
        idempotencyKey: 'order-1001',
        codes,
      }),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_AUTO_VERIFY_DISABLED' },
    });
    expect(acceptance.accept).not.toHaveBeenCalled();
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  });

  it('answers a request or an order it already stored, even while the source cannot send', async () => {
    readiness.evaluate.mockResolvedValue({
      ready: false,
      blockers: [{ kind: 'credit_denied', code: 'INSUFFICIENT_CREDITS' }],
    });
    acceptance.isKnown.mockResolvedValue(true);
    acceptance.accept.mockResolvedValue({
      eventId: 'event-1',
      order: { id: 'order-1' },
      duplicate: true,
    });

    await expect(
      service.submitOne(apiKey, input, {
        channel: 'api',
        idempotencyKey: 'order-1001',
        codes,
      }),
    ).resolves.toMatchObject({ orderId: 'order-1', duplicate: true });

    // Asked about the request's own namespaced key and the order's identity
    // in the resolved source, which is what `accept` will look up.
    const [asked] = acceptance.isKnown.mock.calls[0];
    expect(asked.event).toMatchObject({
      idempotencyKey: 'api:order-1001',
      storeDomain: 'standalone:org-1',
      orgId: 'org-1',
      integrationId: 'int-1',
    });
    expect(asked.order).toMatchObject({
      orgId: 'org-1',
      integrationId: 'int-1',
      externalOrderId: 'ref:1001',
    });
    expect(acceptance.accept).toHaveBeenCalledTimes(1);
  });

  it('does not look for a stored order while the source can send', async () => {
    await service.submitOne(user, input, {
      channel: 'manual',
      idempotencyKey: 'manual-key-0001',
      codes,
    });

    expect(acceptance.isKnown).not.toHaveBeenCalled();
    expect(acceptance.accept).toHaveBeenCalledTimes(1);
  });
});

describe('Standalone ingestion keys', () => {
  it('keeps manual keys unchanged and namespaces import rows', () => {
    expect(namespaceIdempotencyKey('manual', 'abc-12345')).toBe('abc-12345');
    expect(
      namespaceIdempotencyKey('bulk_import', importRowKey('batch-1', 12)),
    ).toBe('import:batch-1:12');
  });

  it('namespaces API keys so they cannot collide with a manual key', () => {
    expect(namespaceIdempotencyKey('api', 'abc-12345')).toBe('api:abc-12345');
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
