import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { DualAuthGuard } from './dual-auth.guard';
import type { TokenValidatorService } from '../services/token-validator.service';
import {
  createRequestContext,
  runRequestContext,
} from '../../../shared/request-context/request-context';

function createContext() {
  const request = {
    headers: {
      authorization: 'Bearer test-token',
      'x-request-id': 'request-1',
    },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;

  return { context, request };
}

describe('DualAuthGuard', () => {
  it('preserves typed organization authorization failures', async () => {
    const organizationRequired = new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Authenticated user has no organization',
      code: 'ORGANIZATION_REQUIRED',
    });
    const tokenValidator = {
      validateToken: jest.fn().mockRejectedValue(organizationRequired),
    };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };
    const guard = new DualAuthGuard(
      tokenValidator as unknown as TokenValidatorService,
      reflector as unknown as Reflector,
    );
    const { context } = createContext();

    await expect(guard.canActivate(context)).rejects.toBe(organizationRequired);
  });

  it('converts unexpected validation failures to unauthorized', async () => {
    const tokenValidator = {
      validateToken: jest.fn().mockRejectedValue(new Error('unexpected')),
    };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };
    const guard = new DualAuthGuard(
      tokenValidator as unknown as TokenValidatorService,
      reflector as unknown as Reflector,
    );
    const { context } = createContext();

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('records auth time on the active request context', async () => {
    const user = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'owner',
      source: 'shopify',
      shop: 'synthetic.myshopify.com',
    };
    const tokenValidator = {
      validateToken: jest.fn().mockResolvedValue(user),
    };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };
    const guard = new DualAuthGuard(
      tokenValidator as unknown as TokenValidatorService,
      reflector as unknown as Reflector,
    );
    const { context, request } = createContext();
    const requestContext = createRequestContext('request-1');

    await expect(
      runRequestContext(requestContext, () => guard.canActivate(context)),
    ).resolves.toBe(true);
    expect((request as { user?: unknown }).user).toEqual(user);
    expect(requestContext.authMs).toEqual(expect.any(Number));
  });
});
