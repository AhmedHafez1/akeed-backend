import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  orderApiError,
  toOrderApiErrorEnvelope,
  toOrderApiFailure,
} from './order-api.errors';

const CORRELATION_ID = 'req-12345678';

/** The body a caller would receive for this exception. */
function envelopeOf(exception: unknown) {
  return toOrderApiErrorEnvelope(toOrderApiFailure(exception), CORRELATION_ID);
}

describe('order API error envelope', () => {
  it.each([
    ['API_RATE_LIMITED', 429],
    ['API_PAYLOAD_TOO_LARGE', 413],
    ['API_VALIDATION_FAILED', 400],
    ['API_REQUEST_REJECTED', 400],
    ['API_INTERNAL_ERROR', 500],
  ] as const)('answers %s with status %d', (code, status) => {
    const failure = toOrderApiFailure(orderApiError(code));
    expect(failure).toMatchObject({ status, code });
    expect(failure.message.length).toBeGreaterThan(0);
  });

  it('is exactly {code, message, correlationId} for a coded refusal', () => {
    const exception = new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'Idempotency-Key was already used with different order data.',
      code: 'API_ORDER_IDEMPOTENCY_CONFLICT',
    });

    expect(toOrderApiFailure(exception).status).toBe(409);
    expect(envelopeOf(exception)).toEqual({
      code: 'API_ORDER_IDEMPOTENCY_CONFLICT',
      message: 'Idempotency-Key was already used with different order data.',
      correlationId: CORRELATION_ID,
    });
  });

  it('passes a code it does not own through unchanged (E04.5 credit codes)', () => {
    const exception = new ConflictException({
      statusCode: 409,
      message: 'Not enough credits.',
      code: 'INSUFFICIENT_CREDITS',
    });

    expect(envelopeOf(exception)).toEqual({
      code: 'INSUFFICIENT_CREDITS',
      message: 'Not enough credits.',
      correlationId: CORRELATION_ID,
    });
  });

  it('keeps fieldErrors on a validation failure, text values only', () => {
    const exception = new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Order validation failed.',
      code: 'API_VALIDATION_FAILED',
      fieldErrors: {
        customerPhone: 'customerPhone is invalid.',
        nested: { leaked: true },
      },
    });

    expect(envelopeOf(exception)).toEqual({
      code: 'API_VALIDATION_FAILED',
      message: 'Order validation failed.',
      correlationId: CORRELATION_ID,
      fieldErrors: { customerPhone: 'customerPhone is invalid.' },
    });
  });

  it('drops extra fields of any other coded error', () => {
    const exception = new HttpException(
      {
        statusCode: 409,
        message: 'The store this API key belongs to cannot accept orders.',
        code: 'API_SOURCE_UNAVAILABLE',
        fieldErrors: { orgId: 'other-tenant' },
        orgId: '22222222-2222-4222-8222-222222222222',
        retryAfterSeconds: 12,
      },
      409,
    );

    expect(envelopeOf(exception)).toEqual({
      code: 'API_SOURCE_UNAVAILABLE',
      message: 'The store this API key belongs to cannot accept orders.',
      correlationId: CORRELATION_ID,
    });
  });

  it.each([
    ['a plain 400', new BadRequestException('Unexpected token } in JSON'), 400],
    ['a plain 401', new UnauthorizedException(), 401],
    ['a plain 404', new NotFoundException('Cannot POST /api/v1/orders/x'), 404],
    [
      'a coded error whose code is empty',
      new HttpException({ code: '', message: 'select * from orders' }, 422),
      422,
    ],
  ])(
    'answers %s with a fixed message and its status',
    (_case, exception, status) => {
      expect(toOrderApiFailure(exception).status).toBe(status);
      expect(envelopeOf(exception)).toEqual({
        code: 'API_REQUEST_REJECTED',
        message: 'The request was rejected.',
        correlationId: CORRELATION_ID,
      });
    },
  );

  it('uses a fixed message when a coded error carries a list of messages', () => {
    const exception = new BadRequestException({
      message: ['customerPhone must be text', 'value: +201001234567'],
      code: 'SOME_CODE',
    });

    expect(envelopeOf(exception)).toEqual({
      code: 'SOME_CODE',
      message: 'The request was rejected.',
      correlationId: CORRELATION_ID,
    });
  });

  it('keeps a coded 503 as it was written', () => {
    const exception = new ServiceUnavailableException({
      statusCode: 503,
      message:
        'The order could not be durably accepted. Retry with the same Idempotency-Key.',
      code: 'API_ORDER_ACCEPTANCE_FAILED',
    });

    expect(toOrderApiFailure(exception)).toEqual({
      status: 503,
      code: 'API_ORDER_ACCEPTANCE_FAILED',
      message:
        'The order could not be durably accepted. Retry with the same Idempotency-Key.',
    });
  });

  describe('unexpected failures', () => {
    const databaseError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "orders_integration_external_id_idx" Key (customer_phone)=(+201001234567)',
      ),
      { code: '23505', query: 'insert into "orders" ("org_id") values ($1)' },
    );

    it.each<[string, unknown, string]>([
      ['a database error', databaseError, '23505'],
      [
        'a wrapped database error',
        new Error('Failed query', { cause: databaseError }),
        '23505',
      ],
      [
        'a programming error',
        new TypeError('x is not a function'),
        'TypeError',
      ],
      [
        'a thrown string',
        'connection to 10.0.0.5:5432 refused',
        'UnknownError',
      ],
      [
        'an uncoded 502',
        new HttpException('upstream body: secret-token', 502),
        'http_502',
      ],
    ])(
      'answers %s as 500 API_INTERNAL_ERROR and keeps the cause for the log only',
      (_case, exception, errorCode) => {
        const failure = toOrderApiFailure(exception);
        expect(failure).toMatchObject({
          status: 500,
          code: 'API_INTERNAL_ERROR',
          errorCode,
        });

        const envelope = envelopeOf(exception);
        expect(Object.keys(envelope).sort()).toEqual([
          'code',
          'correlationId',
          'message',
        ]);
        const sent = JSON.stringify(envelope);
        for (const secret of [
          'duplicate key',
          '+201001234567',
          'insert into',
          '10.0.0.5',
          'secret-token',
          'is not a function',
          errorCode,
        ])
          expect(sent).not.toContain(secret);
      },
    );
  });
});
