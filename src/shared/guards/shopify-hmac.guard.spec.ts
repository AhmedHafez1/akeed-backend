import { ShopifyHmacGuard } from './shopify-hmac.guard';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';

describe('ShopifyHmacGuard', () => {
  let guard: ShopifyHmacGuard;
  const mockSecret = 'test_secret';

  beforeEach(() => {
    process.env.SHOPIFY_API_SECRET = mockSecret;
    guard = new ShopifyHmacGuard();
  });

  afterEach(() => {
    delete process.env.SHOPIFY_API_SECRET;
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('should return true for valid HMAC', () => {
    const rawBody = Buffer.from('{"test": "data"}');
    const hash = crypto
      .createHmac('sha256', mockSecret)
      .update(rawBody)
      .digest('base64');

    const mockRequest = {
      headers: {
        'x-shopify-hmac-sha256': hash,
      },
      rawBody: rawBody,
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw UnauthorizedException for invalid HMAC', () => {
    const rawBody = Buffer.from('{"test": "data"}');
    const validHash = crypto
      .createHmac('sha256', mockSecret)
      .update(rawBody)
      .digest('base64');

    // Mutate hash to make it invalid
    const invalidHash = 'invalid' + validHash.substring(7);

    const mockRequest = {
      headers: {
        'x-shopify-hmac-sha256': invalidHash,
      },
      rawBody: rawBody,
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException if header is missing', () => {
    const mockRequest = {
      headers: {},
      rawBody: Buffer.from('data'),
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException if rawBody is missing', () => {
    const hash = crypto
      .createHmac('sha256', mockSecret)
      .update('data')
      .digest('base64');

    const mockRequest = {
      headers: { 'x-shopify-hmac-sha256': hash },
      // rawBody missing
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
