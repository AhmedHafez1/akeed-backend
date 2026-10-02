import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { ManualOrderAcceptanceInput } from '../../infrastructure/database/repositories/manual-order-ingestion.repository';
import { PhoneService } from '../../shared/services/phone.service';
import { ApiOrderChannelAdapter } from '../order-api/api-order.channel-adapter';
import { CreateApiOrderDto } from '../order-api/dto/create-api-order.dto';
import { FileImportChannelAdapter } from '../order-imports/file-import.channel-adapter';
import { CreateManualOrderDto } from '../orders/dto/create-manual-order.dto';
import { ManualOrderChannelAdapter } from '../orders/manual-order.channel-adapter';
import { normalizeOrderReference } from './standalone-ingestion-keys';
import { StandaloneOrderIngestionService } from './standalone-order-ingestion.service';

const ctx = {
  orgId: 'org-1',
  source: { id: 'int-1', platformStoreUrl: 'standalone:org-1' },
};
const phoneService = new PhoneService();
const apiAdapter = new ApiOrderChannelAdapter(phoneService);

/** What each channel's own request validation hands its adapter. */
function validated<T extends object>(type: new () => T, body: object): T {
  const dto = plainToInstance(type, body);
  expect(validateSync(dto)).toEqual([]);
  return dto;
}

function setup() {
  const captured: ManualOrderAcceptanceInput[] = [];
  const accepted = (input: ManualOrderAcceptanceInput) => {
    captured.push(input);
    return { eventId: 'event-1', order: { id: 'order-1' }, duplicate: false };
  };
  const service = new StandaloneOrderIngestionService(
    {
      accept: (input: ManualOrderAcceptanceInput) =>
        Promise.resolve(accepted(input)),
      acceptMany: (inputs: ManualOrderAcceptanceInput[]) =>
        Promise.resolve(
          inputs.map((input) => ({ status: 'accepted', ...accepted(input) })),
        ),
    } as never,
    { dispatchById: () => Promise.resolve('dispatched') } as never,
    { findByOrderId: () => Promise.resolve(undefined) } as never,
    {} as never,
    {} as never,
  );
  return { service, captured };
}

const EXTRAS = {
  orderDate: '2026-10-02',
  city: 'Cairo',
  address: '12 Nile St',
  notes: 'Call first',
};

/**
 * US-05-02: one order, three channels. The manual form, a file import row and
 * an API request describing the same order must reach the acceptance
 * repository as the same canonical order, in the same key order, with the
 * same fingerprint. Only the audit metadata (channel, namespaced key, import
 * batch) and the manual form's own identity scheme may differ.
 */
describe('Standalone channel equivalence: manual, file import and API', () => {
  const manualDto = validated(CreateManualOrderDto, {
    customerPhone: '+20 100 123 4567',
    customerName: ' Mona Ali ',
    orderNumber: '#1001',
    totalPrice: '450.00',
    currency: 'egp',
    paymentMethod: 'Cash_On_Delivery',
  });
  const manualInput = ManualOrderChannelAdapter.toCanonicalOrderInput(
    manualDto,
    {
      idempotencyKey: 'manual-key-0001',
      customerPhone: phoneService.standardize(manualDto.customerPhone),
    },
  );

  const apiBody = {
    externalOrderId: '#1001',
    customerPhone: '+20 100 123 4567',
    customerName: ' Mona Ali ',
    totalPrice: '450.00',
    currency: 'egp',
    paymentMethod: 'Cash_On_Delivery',
  };
  const importRow = (extras: Partial<typeof EXTRAS> = {}) =>
    FileImportChannelAdapter.toAcceptManyInput(
      {
        rowNumber: 2,
        normalized: {
          orderNumber: '#1001',
          customerPhone: '+201001234567',
          customerName: 'Mona Ali',
          totalPrice: '450.00',
          currency: 'EGP',
          paymentMethod: 'cash on delivery',
          ...extras,
        },
        dedupeKey: normalizeOrderReference('#1001'),
      },
      { id: 'batch-1', shortCode: 'ABC123' },
    );

  it('API and file import translate the order into the same CanonicalOrderInput', () => {
    expect(
      apiAdapter.toCanonicalOrderInput(validated(CreateApiOrderDto, apiBody)),
    ).toEqual(importRow().order);
    expect(
      apiAdapter.toCanonicalOrderInput(
        validated(CreateApiOrderDto, { ...apiBody, ...EXTRAS }),
      ),
    ).toEqual(importRow(EXTRAS).order);
  });

  it('the manual form differs from them only in its own identity scheme', () => {
    const { extras, ...apiInput } = apiAdapter.toCanonicalOrderInput(
      validated(CreateApiOrderDto, apiBody),
    );
    expect(extras).toEqual({});
    expect(manualInput.externalOrderId).toMatch(/^manual-[a-f0-9]{40}$/);
    expect(apiInput.externalOrderId).toBe('ref:1001');
    expect({
      ...manualInput,
      externalOrderId: apiInput.externalOrderId,
    }).toEqual(apiInput);
  });

  it.each([
    ['without extras', {}],
    ['with extras', EXTRAS],
  ])(
    'API and file import store the same order and fingerprint (%s)',
    async (_case, extras) => {
      const { service, captured } = setup();
      await service.acceptOne(
        ctx,
        apiAdapter.toCanonicalOrderInput(
          validated(CreateApiOrderDto, { ...apiBody, ...extras }),
        ),
        { channel: 'api', idempotencyKey: 'order-1001' },
      );
      await service.acceptMany(ctx, [importRow(extras)], {
        channel: 'bulk_import',
        hold: { groupId: 'batch-1' },
      });
      const [api, bulk] = captured;

      // Serialized, so key order is compared too: it is part of the
      // fingerprint contract.
      expect(JSON.stringify(api.event.rawPayload.order)).toBe(
        JSON.stringify(bulk.event.rawPayload.order),
      );
      expect(api.event.submissionFingerprint).toBe(
        bulk.event.submissionFingerprint,
      );
      // The order row itself, apart from the payload copy it carries.
      const row = (order: typeof api.order) =>
        JSON.stringify({ ...order, rawPayload: undefined });
      expect(row(api.order)).toBe(row(bulk.order));
      expect(api.event.storeDomain).toBe(bulk.event.storeDomain);

      // What may differ: audit metadata only.
      expect(api.event.rawPayload.ingestionType).toBe('api');
      expect(bulk.event.rawPayload.ingestionType).toBe('bulk_import');
      expect(api.event.idempotencyKey).toBe('api:order-1001');
      expect(bulk.event.idempotencyKey).toBe('import:batch-1:2');
      expect(Object.keys(api.event.rawPayload)).toEqual([
        'ingestionType',
        'schemaVersion',
        'submissionFingerprint',
        'order',
      ]);
      expect(Object.keys(bulk.event.rawPayload)).toEqual([
        'ingestionType',
        'schemaVersion',
        'submissionFingerprint',
        'importBatchId',
        'importRowNumber',
        'order',
      ]);
    },
  );

  it('the manual form stores the same envelope, identity aside', async () => {
    const { service, captured } = setup();
    await service.acceptOne(ctx, manualInput, {
      channel: 'manual',
      idempotencyKey: 'manual-key-0001',
    });
    await service.acceptOne(
      ctx,
      apiAdapter.toCanonicalOrderInput(validated(CreateApiOrderDto, apiBody)),
      { channel: 'api', idempotencyKey: 'order-1001' },
    );
    const [manual, api] = captured;
    const manualOrder = manual.event.rawPayload.order as Record<
      string,
      unknown
    >;
    const apiOrder = api.event.rawPayload.order as Record<string, unknown>;

    expect(Object.keys(manualOrder)).toEqual(Object.keys(apiOrder));
    expect(Object.keys(manual.event.rawPayload)).toEqual(
      Object.keys(api.event.rawPayload),
    );
    expect(
      JSON.stringify({
        ...manualOrder,
        externalOrderId: apiOrder.externalOrderId,
      }),
    ).toBe(JSON.stringify(apiOrder));
    // A different identity is a different order, so the fingerprints differ
    // for that reason and no other.
    expect(manual.event.submissionFingerprint).not.toBe(
      api.event.submissionFingerprint,
    );
    expect(manual.event.idempotencyKey).toBe('manual-key-0001');
  });
});
