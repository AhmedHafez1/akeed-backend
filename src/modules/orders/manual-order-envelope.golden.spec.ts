import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ManualOrderAcceptanceInput } from '../../infrastructure/database/repositories/manual-order-ingestion.repository';
import { OrdersService } from './orders.service';
import { StandaloneOrderIngestionService } from '../order-ingestion/standalone-order-ingestion.service';
import { StandaloneSourceResolver } from '../order-ingestion/standalone-source-resolver';
import { StandaloneSendReadinessService } from '../order-ingestion/standalone-send-readiness.service';

interface GoldenCase {
  name: string;
  idempotencyKey: string;
  customerPhone: string;
  dto: Record<string, string>;
  expected: {
    rawPayloadJson: string;
    submissionFingerprint: string;
    externalOrderId: string;
    order: Record<string, unknown>;
  };
}

/**
 * Recorded from `createManualOrder` before the envelope was extracted.
 *
 * Stored manual events are deduplicated by comparing `submissionFingerprint`,
 * so any drift in key order, number formatting or payment-signal derivation
 * turns a merchant's safe retry into a 409. These fixtures pin the bytes.
 */
const cases = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../test/fixtures/standalone-envelope/manual-envelopes.json',
    ),
    'utf8',
  ),
) as GoldenCase[];

describe('manual order envelope golden fixtures', () => {
  it.each(cases.map((c) => [c.name, c] as const))(
    'produces byte-identical acceptance input for %s',
    async (_name, golden) => {
      const accept = jest
        .fn<
          Promise<{
            eventId: string;
            order: { id: string };
            duplicate: boolean;
          }>,
          [ManualOrderAcceptanceInput]
        >()
        .mockResolvedValue({
          eventId: 'event-1',
          order: { id: 'order-1' },
          duplicate: false,
        });
      const service = buildService(accept, golden.customerPhone);

      await service.createManualOrder(
        { userId: 'user-1', orgId: 'org-1', role: 'owner', source: 'supabase' },
        golden.idempotencyKey,
        golden.dto as never,
      );

      const input = accept.mock.calls[0][0];
      expect(JSON.stringify(input.event.rawPayload)).toBe(
        golden.expected.rawPayloadJson,
      );
      expect(input.event.submissionFingerprint).toBe(
        golden.expected.submissionFingerprint,
      );
      expect(input.event.idempotencyKey).toBe(golden.idempotencyKey);
      expect(JSON.parse(JSON.stringify(input.order))).toEqual(
        golden.expected.order,
      );
    },
  );
});

function buildService(accept: jest.Mock, customerPhone: string): OrdersService {
  const source = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'standalone',
    platformStoreUrl: 'standalone:org-1',
    isActive: true,
    onboardingStatus: 'completed',
    isAutoVerifyEnabled: true,
  };
  const dispatcher = {
    dispatchById: jest.fn().mockResolvedValue('dispatched'),
  };
  return new OrdersService(
    {} as never,
    new StandaloneOrderIngestionService(
      { accept } as never,
      dispatcher as never,
      { findByOrderId: jest.fn().mockResolvedValue(undefined) } as never,
      new StandaloneSourceResolver({
        findActiveByOrg: jest.fn().mockResolvedValue([source]),
      } as never),
    ),
    { standardize: () => customerPhone } as never,
    new StandaloneSendReadinessService(
      {
        accountingModeFor: () => 'periodic_plan',
        evaluateAccess: () => ({ allowed: true, reason: null }),
        hasAvailableSlot: jest.fn().mockResolvedValue({ available: true }),
      } as never,
      { resolveDenial: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
    ),
    dispatcher as never,
    {} as never,
  );
}
