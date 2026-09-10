import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  parseStandaloneBillingOperationsConfig,
  STANDALONE_BILLING_OPERATIONS_CONFIG,
} from '../../shared/config/standalone-billing-operations.config';
import { StandaloneBillingOperatorGuard } from './standalone-billing-operator.guard';

const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';
const OTHER_STAFF = '0f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

function guard(environment: Record<string, string>) {
  const operations = parseStandaloneBillingOperationsConfig(environment);
  return new StandaloneBillingOperatorGuard({
    get: (key: string) =>
      key === STANDALONE_BILLING_OPERATIONS_CONFIG ? operations : undefined,
  } as unknown as ConfigService);
}

function context(userId?: string): ExecutionContext {
  const request = {
    method: 'POST',
    path: '/api/admin/standalone-billing/accounts/org/adjustments/apply',
    headers: { 'x-request-id': 'req-1' },
    admin: userId ? { userId, role: 'admin', aal: 'aal2' } : undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function codeOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return ((error as ForbiddenException).getResponse() as { code: string })
      .code;
  }
  return null;
}

describe('StandaloneBillingOperatorGuard', () => {
  const enabled = {
    STANDALONE_BILLING_OPERATIONS_ENABLED: 'true',
    STANDALONE_BILLING_OPERATOR_IDS: OPERATOR,
  };

  it('admits a named operator while operations are enabled', () => {
    expect(guard(enabled).canActivate(context(OPERATOR))).toBe(true);
  });

  it('refuses every staff member while operations are disabled', () => {
    expect(
      codeOf(() =>
        guard({ STANDALONE_BILLING_OPERATOR_IDS: OPERATOR }).canActivate(
          context(OPERATOR),
        ),
      ),
    ).toBe('STANDALONE_BILLING_OPERATIONS_DISABLED');
  });

  it('refuses staff who are not named operators', () => {
    expect(codeOf(() => guard(enabled).canActivate(context(OTHER_STAFF)))).toBe(
      'STANDALONE_BILLING_OPERATOR_REQUIRED',
    );
  });

  it('refuses a request no staff guard authenticated', () => {
    expect(codeOf(() => guard(enabled).canActivate(context()))).toBe(
      'STANDALONE_BILLING_OPERATOR_REQUIRED',
    );
  });
});
