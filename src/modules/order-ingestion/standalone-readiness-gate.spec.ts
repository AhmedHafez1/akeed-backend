import { HttpException } from '@nestjs/common';
import {
  assertSendReady,
  MANUAL_ORDER_READINESS_CODES,
  type StandaloneReadinessCodeMap,
} from './standalone-readiness-gate';
import type { SendReadinessBlocker } from './standalone-send-readiness.types';

const CHANNEL_CODES: StandaloneReadinessCodeMap = {
  entitlementRequired: {
    code: 'X_ENTITLEMENT_REQUIRED',
    message: 'entitlement copy',
  },
  autoVerifyDisabled: { code: 'X_AUTO_VERIFY_DISABLED', message: 'auto copy' },
  planLimitReached: { code: 'X_PLAN_LIMIT_REACHED', message: 'limit copy' },
  setupIncomplete: { code: 'X_SETUP_INCOMPLETE', message: 'setup copy' },
};

const ENTITLEMENT: SendReadinessBlocker = {
  kind: 'entitlement_required',
  reason: 'billing_not_active',
};
const AUTO_VERIFY: SendReadinessBlocker = { kind: 'auto_verify_disabled' };
const CREDIT: SendReadinessBlocker = {
  kind: 'credit_denied',
  code: 'INSUFFICIENT_CREDITS',
  shortfall: 1,
  available: 0,
};
const PLAN_LIMIT: SendReadinessBlocker = {
  kind: 'slot_unavailable',
  reason: 'plan_limit_reached',
  consumedCount: 30,
  includedLimit: 30,
  slotsRemaining: 0,
};

function denial(
  blockers: SendReadinessBlocker[],
  codes: StandaloneReadinessCodeMap = MANUAL_ORDER_READINESS_CODES,
): { status: number; body: unknown } {
  try {
    assertSendReady(blockers, codes);
  } catch (error) {
    if (error instanceof HttpException)
      return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
  throw new Error('expected a denial');
}

describe('assertSendReady', () => {
  it('lets a ready source through', () => {
    expect(() => assertSendReady([], CHANNEL_CODES)).not.toThrow();
  });

  // The manual responses are the contract the frontend already switches on,
  // so the bodies are asserted in full, key order included.
  describe('manual-order code map', () => {
    it.each<[string, SendReadinessBlocker[], Record<string, unknown>]>([
      [
        'a missing entitlement',
        [ENTITLEMENT],
        {
          statusCode: 409,
          error: 'Conflict',
          message: 'An active Standalone entitlement is required.',
          code: 'MANUAL_ORDER_ENTITLEMENT_REQUIRED',
          reason: 'billing_not_active',
        },
      ],
      [
        'automatic verification switched off',
        [AUTO_VERIFY],
        {
          statusCode: 409,
          error: 'Conflict',
          message: 'Enable automatic verification before creating an order.',
          code: 'MANUAL_ORDER_AUTO_VERIFY_DISABLED',
        },
      ],
      [
        'a credit denial',
        [CREDIT],
        {
          statusCode: 409,
          error: 'Conflict',
          message: 'Credit is not available for this action.',
          code: 'INSUFFICIENT_CREDITS',
          reason: 'INSUFFICIENT_CREDITS',
        },
      ],
      [
        'a used-up plan',
        [PLAN_LIMIT],
        {
          statusCode: 409,
          error: 'Conflict',
          message: 'The included verifications for this period are used up.',
          code: 'MANUAL_ORDER_PLAN_LIMIT_REACHED',
          reason: 'plan_limit_reached',
          consumedCount: 30,
          includedLimit: 30,
        },
      ],
      [
        'a slot refused for the entitlement',
        [
          {
            kind: 'slot_unavailable',
            reason: 'billing_not_active',
            consumedCount: 0,
            includedLimit: 0,
          },
        ],
        {
          statusCode: 409,
          error: 'Conflict',
          message: 'An active Standalone entitlement is required.',
          code: 'MANUAL_ORDER_ENTITLEMENT_REQUIRED',
          reason: 'billing_not_active',
          consumedCount: 0,
          includedLimit: 0,
        },
      ],
      [
        'a slot refused for credit',
        [
          {
            kind: 'slot_unavailable',
            reason: 'CREDIT_ACCOUNT_SUSPENDED',
            consumedCount: 0,
            includedLimit: 0,
          },
        ],
        {
          statusCode: 409,
          error: 'Conflict',
          message: 'An active Standalone entitlement is required.',
          code: 'CREDIT_ACCOUNT_SUSPENDED',
          reason: 'CREDIT_ACCOUNT_SUSPENDED',
          consumedCount: 0,
          includedLimit: 0,
        },
      ],
      [
        'a source that is not active',
        [{ kind: 'source_inactive' }],
        {
          statusCode: 409,
          error: 'Conflict',
          message: 'Complete Standalone setup before creating an order.',
          code: 'MANUAL_ORDER_SETUP_INCOMPLETE',
        },
      ],
    ])('answers the unchanged body for %s', (_case, blockers, body) => {
      const result = denial(blockers);
      expect(result.status).toBe(409);
      expect(JSON.stringify(result.body)).toBe(JSON.stringify(body));
    });
  });

  describe('precedence', () => {
    const code = (blockers: SendReadinessBlocker[]) =>
      (denial(blockers, CHANNEL_CODES).body as { code: string }).code;

    it('answers entitlement before everything else', () => {
      expect(code([PLAN_LIMIT, CREDIT, AUTO_VERIFY, ENTITLEMENT])).toBe(
        'X_ENTITLEMENT_REQUIRED',
      );
    });

    it('answers automatic verification before credit and slots', () => {
      expect(code([PLAN_LIMIT, CREDIT, AUTO_VERIFY])).toBe(
        'X_AUTO_VERIFY_DISABLED',
      );
    });

    it('answers the credit code before a slot', () => {
      expect(code([PLAN_LIMIT, CREDIT])).toBe('INSUFFICIENT_CREDITS');
    });

    it('answers the plan limit in the channel vocabulary', () => {
      expect(denial([PLAN_LIMIT], CHANNEL_CODES).body).toMatchObject({
        code: 'X_PLAN_LIMIT_REACHED',
        message: 'limit copy',
      });
    });

    it.each<SendReadinessBlocker>([
      { kind: 'source_inactive' },
      { kind: 'setup_incomplete' },
      { kind: 'order_ineligible', reason: 'non_cod_payment_method' },
    ])('fails closed on $kind', (blocker) => {
      expect(denial([blocker], CHANNEL_CODES).body).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: 'setup copy',
        code: 'X_SETUP_INCOMPLETE',
      });
    });

    it('still answers a real blocker when an unmapped one is also present', () => {
      expect(code([{ kind: 'source_inactive' }, CREDIT])).toBe(
        'INSUFFICIENT_CREDITS',
      );
    });
  });
});
