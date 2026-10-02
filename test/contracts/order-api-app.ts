import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import request from 'supertest';
import { IntegrationApiKeysRepository } from '../../src/infrastructure/database/repositories/integration-api-keys.repository';
import { IntegrationApiKeyGuard } from '../../src/modules/integration-keys/guards/integration-api-key.guard';
import { ApiOrderChannelAdapter } from '../../src/modules/order-api/api-order.channel-adapter';
import {
  OrderApiIngressThrottleGuard,
  OrderApiThrottleGuard,
} from '../../src/modules/order-api/edge/order-api-throttle.guard';
import { applyOrderApiEdge } from '../../src/modules/order-api/edge/order-api.edge';
import { OrderApiController } from '../../src/modules/order-api/order-api.controller';
import { StandaloneOrderIngestionService } from '../../src/modules/order-ingestion/standalone-order-ingestion.service';
import {
  ORDER_API_CONFIG,
  parseOrderApiConfig,
  type OrderApiConfig,
} from '../../src/shared/config/order-api.config';
import { PhoneService } from '../../src/shared/services/phone.service';
import type { ReleaseGateHarness } from './release-gate-harness';

export const ORDER_API_PATH = '/api/v1/orders';

/** The limits a deployment runs with when no variable overrides them. */
export const DEFAULT_ORDER_API_LIMITS = parseOrderApiConfig({});

/** Creates `integration_api_keys` in the harness schema (migration 0046). */
export async function migrateIntegrationApiKeys(
  gate: Pick<ReleaseGateHarness, 'client'>,
): Promise<void> {
  for (const statement of readFileSync(
    resolve(__dirname, '../../drizzle/0046_integration_api_keys.sql'),
    'utf8',
  ).split('--> statement-breakpoint'))
    if (statement.trim()) await gate.client.unsafe(statement);
}

/**
 * The order API as `main.ts` mounts it: the production edge, guards, route
 * pipe, controller and adapter in front of an ingestion command. Each app has
 * its own throttler buckets. A fault suite passes the key repository or the
 * ingestion command it has broken; everything else is the real thing.
 */
export async function createOrderApiApp(options: {
  keys: IntegrationApiKeysRepository;
  ingestion: StandaloneOrderIngestionService;
  limits?: OrderApiConfig;
}): Promise<INestApplication> {
  const limits = options.limits ?? DEFAULT_ORDER_API_LIMITS;
  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 60 }] }),
    ],
    controllers: [OrderApiController],
    providers: [
      ApiOrderChannelAdapter,
      PhoneService,
      IntegrationApiKeyGuard,
      OrderApiIngressThrottleGuard,
      OrderApiThrottleGuard,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => (key === ORDER_API_CONFIG ? limits : undefined),
        },
      },
      { provide: IntegrationApiKeysRepository, useValue: options.keys },
      {
        provide: StandaloneOrderIngestionService,
        useValue: options.ingestion,
      },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  applyOrderApiEdge(app);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  await app.init();
  return app;
}

/** One request as an integrator's server sends it. */
export function postOrder(
  app: INestApplication,
  apiKey: string,
  idempotencyKey: string | null,
  body: Record<string, unknown>,
) {
  const call = request(app.getHttpServer() as Server)
    .post(ORDER_API_PATH)
    .set('Authorization', `Bearer ${apiKey}`);
  return (
    idempotencyKey === null ? call : call.set('Idempotency-Key', idempotencyKey)
  ).send(body);
}
