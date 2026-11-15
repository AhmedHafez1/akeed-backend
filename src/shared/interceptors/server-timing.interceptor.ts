import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { tap, type Observable } from 'rxjs';
import {
  connectionsOpenedSince,
  currentRequestContext,
  type RequestContext,
} from '../request-context/request-context';

/**
 * Durations in milliseconds and plain counts only: the header is readable by
 * the browser, so it must never carry an identity, a statement or a reason.
 */
export function buildServerTimingHeader(
  context: RequestContext,
  handlerMs: number,
  now = Date.now(),
): string {
  const entries: string[] = [];
  if (context.authMs !== undefined)
    entries.push(`auth;dur=${Math.round(context.authMs)}`);
  entries.push(
    `handler;dur=${Math.round(handlerMs)}`,
    `total;dur=${Math.round(now - context.startedAt)}`,
    `db;dur=${Math.round(context.db.totalMs)}`,
    `dbmax;dur=${Math.round(context.db.maxMs)}`,
    `dbq;dur=${context.db.count}`,
    `dbconn;dur=${connectionsOpenedSince(context)}`,
  );
  return entries.join(', ');
}

/** Reports where a request spent its time, for the opt-in frontend diagnostics. */
@Injectable()
export class ServerTimingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const requestContext = currentRequestContext();
    if (!requestContext || context.getType() !== 'http') return next.handle();
    const response = context.switchToHttp().getResponse<Response>();
    const handlerStartedAt = Date.now();
    requestContext.handlerStartedAt = handlerStartedAt;
    const write = () => {
      requestContext.handlerMs = Date.now() - handlerStartedAt;
      if (response.headersSent) return;
      response.setHeader(
        'Server-Timing',
        buildServerTimingHeader(requestContext, requestContext.handlerMs),
      );
    };
    return next.handle().pipe(tap({ next: write, error: write }));
  }
}
