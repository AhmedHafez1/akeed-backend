import type { NextFunction, Request, Response } from 'express';
import { RequestContextMiddleware } from './request-context.middleware';
import { currentRequestContext } from './request-context';

function run(headers: Record<string, string | string[]>) {
  const middleware = new RequestContextMiddleware();
  let seen: ReturnType<typeof currentRequestContext>;
  const next: NextFunction = () => {
    seen = currentRequestContext();
  };
  const response = {
    writeHead: jest.fn(),
    setHeader: jest.fn(),
    headersSent: false,
  };
  middleware.use(
    { headers } as unknown as Request,
    response as unknown as Response,
    next,
  );
  return seen;
}

describe('RequestContextMiddleware', () => {
  it('runs the rest of the pipeline inside a fresh request context', () => {
    const context = run({ 'x-request-id': 'req-9' });
    expect(context).toMatchObject({
      requestId: 'req-9',
      db: { count: 0, writes: 0 },
    });
    expect(currentRequestContext()).toBeUndefined();
  });

  it('takes the first value of a repeated header and tolerates none', () => {
    expect(run({ 'x-request-id': ['a', 'b'] })?.requestId).toBe('a');
    expect(run({})?.requestId).toBeUndefined();
  });
});
