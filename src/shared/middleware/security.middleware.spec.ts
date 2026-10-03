import type { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { SecurityMiddleware } from './security.middleware';

const CALLBACK_PATH = '/api/easyorders/install/callback/some-token';
const EASYORDERS_ORIGIN = 'https://app.easy-orders.net';

function run(options: {
  method: string;
  url: string;
  origin?: string;
  env?: Record<string, string>;
}) {
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    ...options.env,
  };
  const headers = new Map<string, string>();
  const response = {
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    },
    status: jest.fn().mockReturnThis(),
    end: jest.fn(),
  };
  const next = jest.fn();
  const middleware = new SecurityMiddleware({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

  middleware.use(
    {
      method: options.method,
      originalUrl: options.url,
      headers: options.origin ? { origin: options.origin } : {},
    } as unknown as Request,
    response as unknown as Response,
    next as NextFunction,
  );
  return { headers, response, next };
}

describe('SecurityMiddleware route-scoped CORS', () => {
  it('answers the install callback preflight for the EasyOrders dashboard origin', () => {
    const { headers, response, next } = run({
      method: 'OPTIONS',
      url: CALLBACK_PATH,
      origin: EASYORDERS_ORIGIN,
    });

    expect(headers.get('access-control-allow-origin')).toBe(EASYORDERS_ORIGIN);
    expect(headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(headers.has('access-control-allow-credentials')).toBe(false);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil.example',
    'https://app.easy-orders.net.evil.example',
    'http://app.easy-orders.net',
    'https://getakeed.com',
  ])('does not allow %s on the install callback', (origin) => {
    const { headers } = run({ method: 'OPTIONS', url: CALLBACK_PATH, origin });

    expect(headers.has('access-control-allow-origin')).toBe(false);
    expect(headers.has('access-control-allow-credentials')).toBe(false);
  });

  it('ignores a wildcard app-wide list on the install callback', () => {
    const { headers } = run({
      method: 'POST',
      url: `${CALLBACK_PATH}?x=1`,
      origin: 'https://evil.example',
      env: { CORS_ALLOWED_ORIGINS: '*' },
    });

    expect(headers.has('access-control-allow-origin')).toBe(false);
  });

  it('does not allow the EasyOrders origin anywhere else', () => {
    const { headers } = run({
      method: 'OPTIONS',
      url: '/api/easyorders/install',
      origin: EASYORDERS_ORIGIN,
    });

    expect(headers.has('access-control-allow-origin')).toBe(false);
  });

  it('leaves every other route on the app-wide rule', () => {
    const { headers, next } = run({
      method: 'GET',
      url: '/api/onboarding/state',
      origin: 'https://getakeed.com',
    });

    expect(headers.get('access-control-allow-origin')).toBe(
      'https://getakeed.com',
    );
    expect(headers.get('access-control-allow-credentials')).toBe('true');
    expect(headers.get('access-control-allow-headers')).toContain(
      'Authorization',
    );
    expect(next).toHaveBeenCalled();
  });
});
