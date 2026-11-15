import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { createRequestContext, runRequestContext } from './request-context';
import { buildServerTimingHeader } from '../interceptors/server-timing.interceptor';

/**
 * Opens the per-request context before the router runs, so guards,
 * interceptors and handlers all share one store. A guard cannot do this:
 * Nest awaits `canActivate` and continues outside anything the guard could
 * have entered. Runs after `SecurityMiddleware`, which assigns the request id.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers['x-request-id'];
    const requestId = Array.isArray(header) ? header[0] : header;
    const context = createRequestContext(requestId);
    const writeHead = res.writeHead.bind(res) as Response['writeHead'];
    // Guards run before interceptors. Finalize at header write so their
    // failures, direct redirects and unmatched routes receive timings too.
    res.writeHead = function (...args: unknown[]) {
      if (!res.headersSent) {
        const handlerMs =
          context.handlerMs ??
          (context.handlerStartedAt === undefined
            ? 0
            : Date.now() - context.handlerStartedAt);
        res.setHeader(
          'Server-Timing',
          buildServerTimingHeader(context, handlerMs),
        );
      }
      return Reflect.apply(writeHead, res, args) as Response;
    };
    runRequestContext(context, () => next());
  }
}
