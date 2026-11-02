import type { IncomingMessage } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { json, type NextFunction, type Request, type Response } from 'express';

export const META_WEBHOOK_PATH = '/webhooks/whatsapp';

/** Meta documents payloads of up to 3 MB. */
export const META_WEBHOOK_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The app-wide parser stops at 100 KB, which answers a large batch 413 before
 * the signature guard could accept it. It keeps the bytes the guard verifies.
 */
const parseJson = json({
  limit: META_WEBHOOK_MAX_BODY_BYTES,
  verify: (request: IncomingMessage & { rawBody?: Buffer }, _res, buffer) => {
    request.rawBody = buffer;
  },
});

/**
 * Wrapped, because the name matters: Nest skips its app-wide JSON parser when
 * any middleware is called `jsonParser`, which is what `json()` returns. Mounted
 * bare, that left every other route with no parsed body and no raw body.
 */
export function metaWebhookBodyParser(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  parseJson(request, response, next);
}

/**
 * Mounts the parser ahead of Nest's own. Call it before the app is
 * initialised: Nest's parser then finds the body already read.
 */
export function applyMetaWebhookEdge(app: INestApplication): void {
  app.use(META_WEBHOOK_PATH, metaWebhookBodyParser);
}
