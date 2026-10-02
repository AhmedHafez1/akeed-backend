import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { tap, type Observable } from 'rxjs';
import { orderApiRequestState } from './order-api-request-state';

/**
 * Notes the outcome of an accepted request for the request log line: the
 * order it produced and whether it was a replay. Failures are noted by the
 * exception filter, and the line itself is written once, by the edge.
 */
@Injectable()
export class OrderApiOutcomeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const state = orderApiRequestState(
      http.getRequest<Request>(),
      http.getResponse<Response>(),
    );
    return next.handle().pipe(
      tap((value: unknown) => {
        if (value === null || typeof value !== 'object') return;
        const answer = value as { orderId?: unknown; duplicate?: unknown };
        if (typeof answer.orderId === 'string') state.orderId = answer.orderId;
        state.resultCode = answer.duplicate === true ? 'duplicate' : 'accepted';
      }),
    );
  }
}
