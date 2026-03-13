import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, RequestWithUser } from './dual-auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    return request.user;
  },
);
