import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StandaloneOrderEligibilityStrategy } from '../../infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { OrderEligibilityService } from '../../modules/verification-core/order-eligibility.service';
import { StandaloneManualOrderNormalizer } from '../../modules/webhook-queue/normalizers/standalone-manual-order.normalizer';
import {
  buildStandaloneOrderEnvelope,
  CANONICAL_ORDER_REQUIRED_FIELDS,
  fingerprintCanonicalOrder,
  STANDALONE_INGESTION_CHANNELS,
  type CanonicalOrderInput,
} from './standalone-order-envelope';

interface GoldenCase {
  name: string;
  customerPhone: string;
  dto: Record<string, string>;
  expected: {
    rawPayloadJson: string;
    submissionFingerprint: string;
    externalOrderId: string;
  };
}

const goldenCases = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../test/fixtures/standalone-envelope/manual-envelopes.json',
    ),
    'utf8',
  ),
) as GoldenCase[];

const order: CanonicalOrderInput = {
  externalOrderId: 'ref:1001',
  orderNumber: '#1001',
  customerPhone: '+201001234567',
  customerName: 'Customer',
  totalPrice: '125.5',
  currency: 'EGP',
  paymentMethod: 'cash on delivery',
};

describe('buildStandaloneOrderEnvelope', () => {
  it.each(goldenCases.map((c) => [c.name, c] as const))(
    'reproduces the recorded manual envelope byte for byte (%s)',
    (_name, golden) => {
      const envelope = buildStandaloneOrderEnvelope({
        ingestionType: 'manual',
        order: {
          externalOrderId: golden.expected.externalOrderId,
          orderNumber: golden.dto.orderNumber,
          customerPhone: golden.customerPhone,
          customerName: golden.dto.customerName,
          totalPrice: golden.dto.totalPrice,
          currency: golden.dto.currency,
          paymentMethod: golden.dto.paymentMethod,
        },
      });

      expect(JSON.stringify(envelope.rawPayload)).toBe(
        golden.expected.rawPayloadJson,
      );
      expect(envelope.submissionFingerprint).toBe(
        golden.expected.submissionFingerprint,
      );
      expect(fingerprintCanonicalOrder(envelope.canonicalOrder)).toBe(
        golden.expected.submissionFingerprint,
      );
    },
  );

  it('places channel metadata beside the order and outside the fingerprint', () => {
    const plain = buildStandaloneOrderEnvelope({
      ingestionType: 'bulk_import',
      order,
    });
    const withBatch = buildStandaloneOrderEnvelope({
      ingestionType: 'bulk_import',
      order,
      extras: { importBatchId: 'batch-1', importRowNumber: 7 },
    });

    expect(Object.keys(withBatch.rawPayload)).toEqual([
      'ingestionType',
      'schemaVersion',
      'submissionFingerprint',
      'importBatchId',
      'importRowNumber',
      'order',
    ]);
    expect(withBatch.submissionFingerprint).toBe(plain.submissionFingerprint);
  });

  it('appends order extras after the fixed fields only when present', () => {
    const envelope = buildStandaloneOrderEnvelope({
      ingestionType: 'bulk_import',
      order: { ...order, extras: { city: 'Cairo', notes: undefined } },
    });

    expect(Object.keys(envelope.canonicalOrder)).toEqual([
      'externalOrderId',
      'orderNumber',
      'customerPhone',
      'customerName',
      'totalPrice',
      'currency',
      'paymentMethod',
      'paymentSignals',
      'codStatus',
      'city',
    ]);
  });

  it.each(['ingestionType', 'schemaVersion', 'submissionFingerprint', 'order'])(
    'refuses channel metadata that would overwrite %s',
    (key) => {
      expect(() =>
        buildStandaloneOrderEnvelope({
          ingestionType: 'bulk_import',
          order,
          extras: { [key]: 'forged' },
        }),
      ).toThrow(key);
    },
  );

  it('writes every field the normalizer requires', () => {
    const envelope = buildStandaloneOrderEnvelope({
      ingestionType: 'manual',
      order,
    });
    for (const field of CANONICAL_ORDER_REQUIRED_FIELDS) {
      expect(typeof envelope.canonicalOrder[field]).toBe('string');
    }
  });
});

describe('Standalone channel equivalence', () => {
  const normalizer = new StandaloneManualOrderNormalizer();
  const eligibility = new OrderEligibilityService([
    new StandaloneOrderEligibilityStrategy(),
  ]);

  it.each([
    ['cash on delivery'],
    ['الدفع عند الاستلام'],
    ['credit card'],
    [''],
  ])(
    'normalizes manual and bulk envelopes to the same order (payment "%s")',
    (paymentMethod) => {
      const [manual, bulk] = STANDALONE_INGESTION_CHANNELS.map(
        (ingestionType) =>
          normalizer.normalizeOrder(
            buildStandaloneOrderEnvelope({
              ingestionType,
              order: { ...order, paymentMethod },
              extras:
                ingestionType === 'bulk_import'
                  ? { importBatchId: 'batch-1', importRowNumber: 2 }
                  : undefined,
            }).rawPayload,
            'source-1',
            'org-1',
          ),
      );

      expect(manual).not.toBeNull();
      expect(bulk).not.toBeNull();
      const { rawPayload: manualPayload, ...manualOrder } = manual!;
      const { rawPayload: bulkPayload, ...bulkOrder } = bulk!;
      expect(bulkOrder).toEqual(manualOrder);
      expect(manualPayload?.ingestionType).toBe('manual');
      expect(bulkPayload?.ingestionType).toBe('bulk_import');

      for (const assumeCodWhenPaymentMissing of [false, true]) {
        const integration = {
          platformType: 'standalone',
          assumeCodWhenPaymentMissing,
        } as never;
        expect(
          eligibility.evaluateOrderForVerification({
            order: bulk!,
            integration,
          }),
        ).toEqual(
          eligibility.evaluateOrderForVerification({
            order: manual!,
            integration,
          }),
        );
      }
    },
  );

  it('rejects an envelope from an unknown channel', () => {
    const { rawPayload } = buildStandaloneOrderEnvelope({
      ingestionType: 'manual',
      order,
    });
    expect(
      normalizer.normalizeOrder(
        { ...rawPayload, ingestionType: 'api' },
        'source-1',
        'org-1',
      ),
    ).toBeNull();
  });
});
