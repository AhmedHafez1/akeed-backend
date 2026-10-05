import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { DrizzleQueryError } from 'drizzle-orm';
import { GlobalExceptionFilter } from './global-exception.filter';

const PHONE = '+201000000000';
const TOKEN_HASH = 'a'.repeat(64);

function failedQuery(): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "orders" ("customer_phone", "token_hash") values ($1, $2)',
    [PHONE, TOKEN_HASH],
    Object.assign(new Error('duplicate key value violates "orders_key"'), {
      code: '23505',
      detail: `Key (customer_phone)=(${PHONE}) already exists.`,
    }),
  );
}

function createFilter() {
  const reply = jest.fn();
  const filter = new GlobalExceptionFilter({
    httpAdapter: { reply, isHeadersSent: () => false, end: jest.fn() },
  } as unknown as HttpAdapterHost);
  const response = {};
  const host = {
    getArgByIndex: () => response,
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { filter, host, reply };
}

describe('GlobalExceptionFilter', () => {
  const logged: string[] = [];

  beforeEach(() => {
    logged.length = 0;
    const capture = (...parts: unknown[]) => {
      logged.push(parts.map(String).join('\n'));
    };
    Logger.overrideLogger({ log: capture, warn: capture, error: capture });
  });

  afterAll(() => {
    Logger.overrideLogger(['log', 'warn', 'error']);
  });

  it('answers 500 for a failed query and logs the statement without its parameters', () => {
    const { filter, host, reply } = createFilter();

    filter.catch(failedQuery(), host);

    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      { statusCode: 500, message: 'Internal server error' },
      500,
    );
    const text = logged.join('\n');
    expect(text).toContain('Failed query: insert into "orders"');
    expect(text).toContain('23505 duplicate key value violates "orders_key"');
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(TOKEN_HASH);
    expect(text).not.toContain('params:');
  });

  it('passes every other exception on as it is', () => {
    const { filter, host, reply } = createFilter();

    filter.catch(new HttpException({ code: 'SOME_CODE' }, 409), host);

    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      { code: 'SOME_CODE' },
      409,
    );
  });
});
