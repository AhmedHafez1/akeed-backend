import type { INestApplication } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IntegrationApiKeysRepository } from '../src/infrastructure/database/repositories/integration-api-keys.repository';
import { generateIntegrationApiKey } from '../src/modules/integration-keys/integration-api-key.secret';
import { MAX_ACTIVE_INTEGRATION_API_KEYS } from '../src/modules/integration-keys/integration-keys.service';
import { CANONICAL_ORDER_CURRENCIES } from '../src/shared/commerce/canonical-order.rules';
import {
  createOrderApiApp,
  DEFAULT_ORDER_API_LIMITS,
  migrateIntegrationApiKeys,
  ORDER_API_PATH,
  postOrder,
} from './contracts/order-api-app';
import { releaseGateHarness } from './contracts/release-gate-harness';

type Scenario =
  | 'ready'
  | 'auto_verify_off'
  | 'setup_incomplete'
  | 'store_inactive'
  | 'one_credit';

interface GuideStep {
  /** The queue worker has processed everything sent before this step. */
  workerRan?: boolean;
  /** Send the request this many times; only the status is checked. */
  repeat?: number;
  request: {
    auth?: 'valid' | 'unknown';
    idempotencyKey: string | null;
    order: string;
    with?: Record<string, unknown>;
    padField?: { name: string; characters: number };
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  };
}

interface GuideExample {
  id: string;
  scenario: Scenario;
  /** WhatsApp messages the whole example leads to. */
  messagesSent: number;
  steps: GuideStep[];
}

interface GuideError {
  code: string;
  status: number;
  example?: string;
  provenBy?: string;
}

interface GuideField {
  name: string;
  required: boolean;
  maxLength?: number;
}

interface GuideFixture {
  path: string;
  limits: {
    perStorePerMinute: number;
    maxBodyBytes: number;
    idempotencyKeyMinLength: number;
    idempotencyKeyMaxLength: number;
  };
  fields: GuideField[];
  currencies: string[];
  orders: Record<string, Record<string, unknown>>;
  errors: GuideError[];
  examples: GuideExample[];
}

const BACKEND_ROOT = resolve(__dirname, '..');

/**
 * The examples, limits, fields and error codes the public guide prints
 * (`akeed-frontend/content/docs/en/server-api.md`). `scripts/order-api-guide.js`
 * renders the guide from this file and fails when the two differ.
 */
const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, 'fixtures/order-api/guide-examples.json'),
    'utf8',
  ),
) as GuideFixture;

/** What US-05-05 acceptance criterion 5 requires an example for. */
const REQUIRED_EXAMPLES = [
  'create-order',
  'replay-same-key',
  'idempotency-conflict',
  'existing-order-different',
  'non-cod',
  'payload-too-large',
  'rate-limited',
  'invalid-phone',
  'store-not-ready',
  'out-of-credits',
  'lost-response-retry',
];

const PLACEHOLDER = /^<[A-Z_]+>$/;

const gate = releaseGateHarness();
const keys = new IntegrationApiKeysRepository(gate.db);
const limits = DEFAULT_ORDER_API_LIMITS;

type TextResponse = { status: number; headers: Record<string, string> };

/** A store in the state the example describes, with a key issued for it. */
async function prepare(scenario: Scenario) {
  const merchant = await gate.merchant(
    scenario === 'auto_verify_off'
      ? { settings: { isAutoVerifyEnabled: false } }
      : scenario === 'one_credit'
        ? { credits: 1 }
        : {},
  );
  const key = generateIntegrationApiKey();
  const issued = await keys.createWithinCap(
    {
      orgId: merchant.orgId,
      integrationId: merchant.integrationId,
      prefix: key.prefix,
      keyHash: key.keyHash,
      name: 'Guide example',
      createdBy: merchant.user.userId,
    },
    MAX_ACTIVE_INTEGRATION_API_KEYS,
  );
  if (issued.kind !== 'created') throw new Error('could not issue a test key');
  if (scenario === 'setup_incomplete')
    await gate.client`
      UPDATE integrations SET onboarding_status = 'pending'
      WHERE id = ${merchant.integrationId}`;
  if (scenario === 'store_inactive')
    await gate.client`
      UPDATE integrations SET is_active = false
      WHERE id = ${merchant.integrationId}`;
  return { merchant, apiKey: key.plaintext };
}

function bodyOf(step: GuideStep): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...fixture.orders[step.request.order],
    ...step.request.with,
  };
  const pad = step.request.padField;
  if (pad) body[pad.name] = 'x'.repeat(pad.characters);
  return body;
}

const send = postOrder;

/**
 * The documented body, key for key. A placeholder stands for any non-empty
 * text, and the same placeholder means the same value for the whole example.
 */
function expectDocumented(
  actual: unknown,
  documented: unknown,
  seen: Map<string, string>,
): void {
  if (typeof documented === 'string' && PLACEHOLDER.test(documented)) {
    expect(typeof actual).toBe('string');
    expect(actual).not.toBe('');
    if (documented === '<CORRELATION_ID>') return;
    if (seen.has(documented)) expect(actual).toBe(seen.get(documented));
    else seen.set(documented, actual as string);
    return;
  }
  if (documented !== null && typeof documented === 'object') {
    expect(actual).toEqual(expect.any(Object));
    const received = actual as Record<string, unknown>;
    const expected = documented as Record<string, unknown>;
    expect(Object.keys(received).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, value] of Object.entries(expected))
      expectDocumented(received[name], value, seen);
    return;
  }
  expect(actual).toBe(documented);
}

function expectDocumentedHeaders(
  response: TextResponse,
  documented: Record<string, string> = {},
): void {
  for (const [name, value] of Object.entries(documented)) {
    const received = response.headers[name.toLowerCase()];
    if (value !== '<SECONDS>') {
      expect(received).toBe(value);
      continue;
    }
    const seconds = Number(received);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
  }
}

/**
 * US-05-05: every example the integration guide prints, run over real HTTP
 * against PostgreSQL with a key issued for the test and dropped with its
 * schema. Real edge, guards, pipe, controller, adapter, repositories and
 * ingestion; only the messaging port and the queues are fakes (see
 * `releaseGateHarness`).
 */
describe('order API guide examples (US-05-05)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await gate.setup();
    await migrateIntegrationApiKeys(gate);
  });
  afterAll(() => gate.teardown());

  // A new app for each test, so no test starts with a used rate-limit bucket.
  beforeEach(async () => {
    app = await createOrderApiApp({
      keys,
      ingestion: gate.services.ingestion,
    });
  });
  afterEach(() => app.close());

  it.each(fixture.examples.map((example) => [example.id, example] as const))(
    'answers the documented status and body: %s',
    async (_id, example) => {
      const { apiKey } = await prepare(example.scenario);
      const sendsBefore = gate.sends.length;
      const seen = new Map<string, string>();

      for (const step of example.steps) {
        if (step.workerRan) await gate.drain();
        const key =
          step.request.auth === 'unknown'
            ? generateIntegrationApiKey().plaintext
            : apiKey;
        for (let attempt = 0; attempt < (step.repeat ?? 1); attempt++) {
          const response = await send(
            app,
            key,
            step.request.idempotencyKey,
            bodyOf(step),
          );
          const body = response.body as Record<string, unknown>;

          expect(response.status).toBe(step.response.status);
          const correlationId = response.headers['x-correlation-id'];
          expect(correlationId).toEqual(expect.any(String));
          expect(response.headers['content-type']).toBe(
            'application/json; charset=utf-8',
          );
          if (response.status >= 400)
            expect(body.correlationId).toBe(correlationId);
          expectDocumentedHeaders(response, step.response.headers);
          if (step.response.body)
            expectDocumented(body, step.response.body, seen);
        }
      }

      await gate.drain();
      expect(gate.sends.length - sendsBefore).toBe(example.messagesSent);
    },
  );

  describe('the documented reference tables', () => {
    it('covers every scenario the story requires an example for', () => {
      const documented = fixture.examples.map((example) => example.id);
      expect(documented).toEqual(expect.arrayContaining(REQUIRED_EXAMPLES));
      expect(new Set(documented).size).toBe(documented.length);
    });

    it('documents the path and the limits a deployment runs with by default', () => {
      expect(fixture.path).toBe(ORDER_API_PATH);
      expect(fixture.limits.perStorePerMinute).toBe(
        limits.perIntegrationPerMinute,
      );
      expect(fixture.limits.maxBodyBytes).toBe(limits.maxBodyBytes);
    });

    it('documents exactly the supported currencies', () => {
      expect([...fixture.currencies].sort()).toEqual(
        [...CANONICAL_ORDER_CURRENCIES].sort(),
      );
    });

    it('proves every documented error code by an example or a named suite', () => {
      for (const error of fixture.errors) {
        if (error.example) {
          const example = fixture.examples.find(
            ({ id }) => id === error.example,
          );
          const answer = example?.steps.at(-1)?.response;
          expect({ code: error.code, status: answer?.status }).toEqual({
            code: error.code,
            status: error.status,
          });
          expect(answer?.body?.code).toBe(error.code);
          continue;
        }
        expect(error.provenBy).toEqual(expect.any(String));
        const suite = resolve(BACKEND_ROOT, error.provenBy as string);
        expect({ suite: error.provenBy, exists: existsSync(suite) }).toEqual({
          suite: error.provenBy,
          exists: true,
        });
        expect(readFileSync(suite, 'utf8')).toContain(error.code);
      }
    });

    it('refuses a request without each required field, and an unknown field', async () => {
      const { apiKey } = await prepare('ready');
      const required = fixture.fields.filter((field) => field.required);
      expect(required.length).toBeGreaterThan(0);

      for (const field of [...required.map(({ name }) => name), 'discount']) {
        const body: Record<string, unknown> = { ...fixture.orders.base };
        if (field === 'discount') body.discount = '10';
        else delete body[field];
        const response = await send(app, apiKey, 'order-fields-1', body);

        expect({ field, status: response.status }).toEqual({
          field,
          status: 400,
        });
        expect(response.body).toMatchObject({ code: 'API_VALIDATION_FAILED' });
        expect(
          Object.keys(
            (response.body as { fieldErrors: Record<string, string> })
              .fieldErrors,
          ),
        ).toContain(field);
      }
    });

    it('accepts each text field at its documented length and refuses one character more', async () => {
      const { apiKey } = await prepare('ready');
      const bounded = fixture.fields.filter(
        (field) => field.maxLength && field.name !== 'customerPhone',
      );
      expect(bounded.length).toBeGreaterThan(0);

      for (const [index, field] of bounded.entries()) {
        const order = {
          ...fixture.orders.base,
          externalOrderId: `length-${index}`,
        };
        const tooLong = await send(app, apiKey, `order-length-${index}-over`, {
          ...order,
          [field.name]: 'x'.repeat((field.maxLength as number) + 1),
        });
        expect({ field: field.name, status: tooLong.status }).toEqual({
          field: field.name,
          status: 400,
        });
        expect(
          Object.keys(
            (tooLong.body as { fieldErrors: Record<string, string> })
              .fieldErrors,
          ),
        ).toEqual([field.name]);

        const atLimit = await send(app, apiKey, `order-length-${index}-fits`, {
          ...order,
          [field.name]: 'x'.repeat(field.maxLength as number),
        });
        expect({ field: field.name, status: atLimit.status }).toEqual({
          field: field.name,
          status: 202,
        });
      }
    });

    it('accepts an Idempotency-Key of the documented lengths only', async () => {
      const { apiKey } = await prepare('ready');
      const { idempotencyKeyMinLength: min, idempotencyKeyMaxLength: max } =
        fixture.limits;
      const order = (id: string) => ({
        ...fixture.orders.base,
        externalOrderId: id,
      });

      for (const length of [min - 1, max + 1]) {
        const response = await send(
          app,
          apiKey,
          'k'.repeat(length),
          order(`key-${length}`),
        );
        expect({ length, status: response.status }).toEqual({
          length,
          status: 400,
        });
        expect(response.body).toMatchObject({
          code: 'API_VALIDATION_FAILED',
          fieldErrors: { idempotencyKey: expect.any(String) as unknown },
        });
      }
      for (const length of [min, max]) {
        const response = await send(
          app,
          apiKey,
          'k'.repeat(length),
          order(`key-${length}`),
        );
        expect({ length, status: response.status }).toEqual({
          length,
          status: 202,
        });
      }
    });
  });
});
