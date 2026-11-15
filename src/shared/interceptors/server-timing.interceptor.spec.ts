import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import {
  buildServerTimingHeader,
  ServerTimingInterceptor,
} from './server-timing.interceptor';
import {
  createRequestContext,
  recordQuery,
  runRequestContext,
} from '../request-context/request-context';

function httpContext(response: { headersSent: boolean; setHeader: jest.Mock }) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ExecutionContext;
}

describe('buildServerTimingHeader', () => {
  it('reports durations and counts as numbers only', () => {
    const context = createRequestContext();
    context.startedAt = 1_000;
    context.authMs = 120.4;
    context.db = {
      count: 3,
      totalMs: 410.6,
      maxMs: 200.2,
      writes: 0,
      transactions: 0,
    };
    const header = buildServerTimingHeader(context, 350.5, 1_900);
    expect(header).toBe(
      'auth;dur=120, handler;dur=351, total;dur=900, db;dur=411, dbmax;dur=200, dbq;dur=3, dbconn;dur=0',
    );
    expect(header).not.toMatch(/desc|org|shop|[a-z]+=[^0-9]/i);
  });

  it('omits auth when no guard ran', () => {
    const context = createRequestContext();
    expect(buildServerTimingHeader(context, 1)).not.toContain('auth;');
  });
});

describe('ServerTimingInterceptor', () => {
  const interceptor = new ServerTimingInterceptor();

  it('sets the header when the handler succeeds', async () => {
    const response = { headersSent: false, setHeader: jest.fn() };
    const context = createRequestContext();
    const result = await runRequestContext(context, () => {
      recordQuery('select 1', 12);
      return lastValueFrom(
        interceptor.intercept(httpContext(response), {
          handle: () => of({ ok: true }),
        } as CallHandler),
      );
    });
    expect(result).toEqual({ ok: true });
    expect(response.setHeader).toHaveBeenCalledWith(
      'Server-Timing',
      expect.stringMatching(/^handler;dur=\d+, total;dur=\d+, db;dur=12, /),
    );
  });

  it('sets the header when the handler fails', async () => {
    const response = { headersSent: false, setHeader: jest.fn() };
    await expect(
      runRequestContext(createRequestContext(), () =>
        lastValueFrom(
          interceptor.intercept(httpContext(response), {
            handle: () => throwError(() => new Error('synthetic')),
          } as CallHandler),
        ),
      ),
    ).rejects.toThrow('synthetic');
    expect(response.setHeader).toHaveBeenCalledTimes(1);
  });

  it('does nothing once headers are sent or without a request context', async () => {
    const sent = { headersSent: true, setHeader: jest.fn() };
    await runRequestContext(createRequestContext(), () =>
      lastValueFrom(
        interceptor.intercept(httpContext(sent), {
          handle: () => of(1),
        } as CallHandler),
      ),
    );
    expect(sent.setHeader).not.toHaveBeenCalled();

    const response = { headersSent: false, setHeader: jest.fn() };
    await lastValueFrom(
      interceptor.intercept(httpContext(response), {
        handle: () => of(1),
      } as CallHandler),
    );
    expect(response.setHeader).not.toHaveBeenCalled();
  });
});
