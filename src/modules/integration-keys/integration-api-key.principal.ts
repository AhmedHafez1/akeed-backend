import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Who an API request authenticated as: one key of one integration.
 *
 * It is not an ingestion context. US-05-02 turns it into the existing
 * `StandaloneIngestionContext` through the source resolver, so the command
 * never learns which authentication produced the order; `keyId` and `prefix`
 * are log metadata only.
 */
export interface IntegrationApiKeyPrincipal {
  orgId: string;
  integrationId: string;
  keyId: string;
  prefix: string;
}

export interface RequestWithIntegrationApiKey extends Request {
  integrationApiKey?: IntegrationApiKeyPrincipal;
}

/** The principal attached by `IntegrationApiKeyGuard`. */
export const CurrentIntegrationKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): IntegrationApiKeyPrincipal => {
    const principal = context
      .switchToHttp()
      .getRequest<RequestWithIntegrationApiKey>().integrationApiKey;
    if (!principal)
      throw new Error(
        'CurrentIntegrationKey used on a route without IntegrationApiKeyGuard',
      );
    return principal;
  },
);
