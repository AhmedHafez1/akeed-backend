import {
  ConflictException,
  Logger,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { StandaloneBillingLoggingInterceptor } from './standalone-billing-logging.interceptor';

const ORG = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

function firstLine(spy: jest.SpyInstance): string {
  return String((spy.mock.calls as unknown[][])[0][0]);
}

function context(body: Record<string, unknown>): ExecutionContext {
  const request = {
    params: { purchaseRef: 'akd_0123456789abcdef0123456789abcdef' },
    body,
    headers: { 'x-request-id': 'req-42' },
    admin: { userId: 'staff-1' },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({ name: 'providerAction' }),
  } as unknown as ExecutionContext;
}

describe('StandaloneBillingLoggingInterceptor', () => {
  const interceptor = new StandaloneBillingLoggingInterceptor();
  const body = {
    orgId: ORG,
    reason: 'Customer called support about card 4111 1111 1111 1111',
    evidence: 'Paymob dashboard screenshot',
    providerReference: 'rf-secret-looking',
  };
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs internal references and the outcome, never the body', async () => {
    const handler: CallHandler = {
      handle: () => of({ outcome: 'reversed', secret: 'client_secret' }),
    };
    await lastValueFrom(interceptor.intercept(context(body), handler));
    const line = firstLine(log);
    expect(JSON.parse(line)).toMatchObject({
      action: 'standalone-billing.providerAction',
      outcome: 'success',
      userId: 'staff-1',
      requestId: 'req-42',
      orgId: ORG,
      reference: 'akd_0123456789abcdef0123456789abcdef',
      resultCode: 'reversed',
    });
    for (const leaked of [
      '4111',
      'screenshot',
      'rf-secret-looking',
      'client_secret',
    ])
      expect(line).not.toContain(leaked);
  });

  it('logs the error code of a refused operation', async () => {
    const handler: CallHandler = {
      handle: () =>
        throwError(
          () =>
            new ConflictException({
              code: 'CREDIT_PROJECTION_MISMATCH',
              message: 'drift',
            }),
        ),
    };
    await expect(
      lastValueFrom(interceptor.intercept(context(body), handler)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(JSON.parse(firstLine(warn))).toMatchObject({
      outcome: 'failure',
      httpStatus: 409,
      errorCode: 'CREDIT_PROJECTION_MISMATCH',
    });
  });

  it('drops an organization id that is not a UUID', async () => {
    const handler: CallHandler = { handle: () => of({}) };
    await lastValueFrom(
      interceptor.intercept(context({ orgId: 'x OR 1=1' }), handler),
    );
    expect(JSON.parse(firstLine(log))).not.toHaveProperty('orgId');
  });
});
