import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type {
  AuthenticatedRequestUser,
  RequestWithUser,
} from './dual-auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedRequestUser => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    return request.user;
  },
);
