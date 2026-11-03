import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import type { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import type { WhatsappTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import { OwnNumberGraphClient } from '../../infrastructure/spokes/meta/own-number/own-number-graph.client';
import {
  encryptConnectionSecret,
  readRegistrationPin,
} from '../../infrastructure/spokes/meta/own-number/whatsapp-connection-credentials';
import {
  META_GRAPH_CONFIG,
  parseMetaGraphConfig,
} from '../../shared/config/meta-graph.config';
import {
  parseWhatsappOwnNumberConfig,
  WHATSAPP_OWN_NUMBER_CONFIG,
} from '../../shared/config/whatsapp-own-number.config';
import {
  FAKE_BUSINESS_TOKEN,
  FAKE_PHONE_NUMBER_ID,
  FAKE_WABA_ID,
} from '../../../test/contracts/meta-signup-fake';
import {
  createMetaSetupFake,
  defaultSetupState,
  FAKE_SETUP_APP_ID,
  type FakeMetaSetupState,
} from '../../../test/contracts/meta-own-number-setup-fake';
import {
  connectionRow,
  InMemoryConnections,
  InMemoryConnectionTemplates,
  registryFake,
} from '../../../test/fixtures/whatsapp-connection-setup.fakes';
import { inspected } from '../../../test/fixtures/whatsapp-connection-setup.fixtures';
import { ConnectionSetupService } from './connection-setup.service';
import { ConnectionTemplatesService } from './connection-templates.service';
import type { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';

const KEY = 'k'.repeat(32);

/** The URL a fetch was called with, whatever form it came in. */
const href = (input: string | URL | Request) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

/** Records the pauses instead of waiting them out. */
class TestTemplatesService extends ConnectionTemplatesService {
  readonly pauses: number[] = [];
  protected pause(ms: number): Promise<void> {
    this.pauses.push(ms);
    return Promise.resolve();
  }
}

const REGISTRY = [
  inspected({ id: 'tpl-en' }),
  inspected({
    id: 'tpl-eg',
    key: 'cod_confirm.ar.egyptian',
    language: 'ar',
    style: 'egyptian',
    templateName: 'akeed_cod_verification_direct_eg',
    languageCode: 'ar_EG',
    isDefault: false,
  }),
  inspected({ id: 'tpl-off', key: 'cod_confirm.en.direct', isActive: false }),
  inspected({ id: 'tpl-old', key: 'cod_confirm.en.short' }),
];

describe('ConnectionSetupService', () => {
  let logs: string[];

  function harness(
    options: {
      state?: FakeMetaSetupState;
      row?: Parameters<typeof connectionRow>[0];
      env?: Record<string, string>;
    } = {},
  ) {
    const meta = createMetaSetupFake(options.state ?? defaultSetupState());
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(meta.fetch as typeof fetch);
    const ownNumberEnv = {
      WHATSAPP_OWN_NUMBER_TEMPLATE_SUBMIT_INTERVAL_MS: '1500',
      ...options.env,
    };
    const config = new ConfigService({
      META_APP_ID: FAKE_SETUP_APP_ID,
      SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY,
      [META_GRAPH_CONFIG]: parseMetaGraphConfig({}),
      [WHATSAPP_OWN_NUMBER_CONFIG]: parseWhatsappOwnNumberConfig(ownNumberEnv),
    });
    const connections = new InMemoryConnections();
    const rows = new InMemoryConnectionTemplates();
    const registry = registryFake(REGISTRY, ['cod_confirm.en.short']);
    const producer = {
      enqueueSetup: jest.fn().mockResolvedValue(true),
      requestTemplateSync: jest.fn().mockResolvedValue(true),
    };
    const graph = new OwnNumberGraphClient(config);
    const templates = new TestTemplatesService(
      config,
      connections as unknown as WhatsappConnectionsRepository,
      rows as unknown as WhatsappConnectionTemplatesRepository,
      registry as unknown as WhatsappTemplatesRepository,
      graph,
      producer as unknown as WhatsappConnectionSetupProducer,
    );
    const service = new ConnectionSetupService(
      config,
      connections as unknown as WhatsappConnectionsRepository,
      graph,
      templates,
      producer as unknown as WhatsappConnectionSetupProducer,
    );
    const row = connections.add(
      connectionRow({
        businessTokenEncrypted: encryptConnectionSecret(
          FAKE_BUSINESS_TOKEN,
          KEY,
        ),
        ...options.row,
      }),
    );
    return {
      meta,
      fetchSpy,
      connections,
      rows,
      registry,
      producer,
      templates,
      service,
      row,
    };
  }

  type Harness = ReturnType<typeof harness>;
  const run = (h: Harness) => h.service.run(h.row.id, h.row.signupGeneration);
  const calls = (h: Harness, method: string, pattern: RegExp) =>
    h.meta.requests.filter((r) => r.method === method && pattern.test(r.path));
  const pinsSent = (h: Harness) =>
    calls(h, 'POST', /\/register$/).map((r) => (r.body as { pin: string }).pin);

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logs.push(String(args[0]));
        });
  });

  afterEach(() => jest.restoreAllMocks());

  /** Runs attempts until setup stops asking for more, like the queue would. */
  async function runToRest(h: Harness, maxRuns = 10) {
    for (let i = 0; i < maxRuns; i += 1) {
      h.connections.makeDue(h.row.id);
      const row = h.connections.get(h.row.id);
      if (row.setupStatus === 'complete' || row.setupStatus === 'exhausted')
        return;
      await run(h);
    }
  }

  describe('new number', () => {
    it('subscribes, registers with a stored PIN, submits the templates and stops at verifying', async () => {
      const h = harness();
      await run(h);

      expect(calls(h, 'GET', /\/subscribed_apps$/)).toHaveLength(1);
      expect(calls(h, 'POST', /\/subscribed_apps$/)).toHaveLength(1);
      const [pin] = pinsSent(h);
      expect(pin).toMatch(/^\d{6}$/);
      const row = h.connections.get(h.row.id);
      expect(readRegistrationPin(row, KEY)).toBe(pin);
      expect(row.registrationPinEncrypted).toMatch(/^v1:/);
      expect(row.registrationPinEncrypted).not.toContain(pin);

      // The PIN is stored before the request that uses it.
      expect(h.connections.writes.indexOf('pin')).toBeLessThan(
        h.connections.writes.indexOf('progress:provision'),
      );

      const created = calls(h, 'POST', /\/message_templates$/).map(
        (r) => r.body as { name: string; language: string; category: string },
      );
      expect(created).toEqual([
        expect.objectContaining({
          name: 'akeed_cod_verification_friendly',
          language: 'en',
          category: 'UTILITY',
        }),
        expect.objectContaining({
          name: 'akeed_cod_verification_direct_eg',
          language: 'ar_EG',
          category: 'UTILITY',
        }),
      ]);
      // Inactive and retired templates are not provisioned.
      expect(h.rows.byTemplate('tpl-off')).toBeUndefined();
      expect(h.rows.byTemplate('tpl-old')).toBeUndefined();
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({
        status: 'pending',
        submittedComponentsHash: expect.stringMatching(
          /^[0-9a-f]{64}$/,
        ) as string,
      });

      expect(row).toMatchObject({
        state: 'verifying',
        setupStatus: 'complete',
        setupStep: 'done',
        providerIsOnBizApp: false,
      });
      expect(row.registeredAt).not.toBeNull();
      expect(row.subscribedAt).not.toBeNull();
    });

    it('never calls contacts or history sync, and keeps the token and PIN out of URLs and logs', async () => {
      const h = harness();
      await run(h);
      const pin = pinsSent(h)[0];
      expect(h.meta.requests.some((r) => r.path.includes('smb_app_data'))).toBe(
        false,
      );
      for (const request of h.meta.requests) {
        expect(JSON.stringify(request.query)).not.toContain(
          FAKE_BUSINESS_TOKEN,
        );
        expect(request.authorization).toBe(`Bearer ${FAKE_BUSINESS_TOKEN}`);
      }
      const all = logs.join('\n');
      expect(all).not.toContain(FAKE_BUSINESS_TOKEN);
      expect(all).not.toContain(pin);
    });

    it('does not subscribe again when Meta already lists the app', async () => {
      const state = defaultSetupState();
      state.subscribedAppIds.add(FAKE_SETUP_APP_ID);
      const h = harness({ state });
      await run(h);
      expect(calls(h, 'POST', /\/subscribed_apps$/)).toHaveLength(0);
      expect(h.connections.get(h.row.id).subscribedAt).not.toBeNull();
    });

    it('reuses the same PIN after a lost answer', async () => {
      const state = defaultSetupState();
      state.failures.register = [{ kind: 'network' }];
      const h = harness({ state });
      await run(h);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'failed',
        setupStep: 'register',
        setupErrorCode: 'register_unresolved',
      });
      h.connections.makeDue(h.row.id);
      await run(h);
      const pins = pinsSent(h);
      expect(pins).toHaveLength(2);
      expect(pins[1]).toBe(pins[0]);
      expect(h.connections.get(h.row.id).setupStatus).toBe('complete');
    });

    it('does not register again when Meta registered the number before its answer was lost', async () => {
      const state = defaultSetupState();
      state.failures.register = [{ kind: 'server_error', httpStatus: 502 }];
      const h = harness({ state });
      await run(h);
      // Meta did register it; only the answer was lost.
      state.phones[FAKE_PHONE_NUMBER_ID].platform_type = 'CLOUD_API';
      h.connections.makeDue(h.row.id);
      await run(h);
      expect(state.registerCalls[FAKE_PHONE_NUMBER_ID]).toBe(1);
      expect(h.connections.get(h.row.id).setupStatus).toBe('complete');
    });

    it("stops for staff after two failed registrations, inside Meta's 72-hour limit", async () => {
      const state = defaultSetupState();
      state.failures.register = [{ kind: 'network' }, { kind: 'network' }];
      const h = harness({ state });
      await runToRest(h);
      expect(state.registerCalls[FAKE_PHONE_NUMBER_ID]).toBe(2);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'exhausted',
        setupErrorCode: 'register_unresolved',
        state: 'connecting',
      });
    });

    it('waits 72 hours when Meta blocks registration', async () => {
      const state = defaultSetupState();
      state.failures.register = [
        { kind: 'meta_error', httpStatus: 400, code: 133016 },
      ];
      const h = harness({ state });
      const before = Date.now();
      await run(h);
      const row = h.connections.get(h.row.id);
      expect(row).toMatchObject({
        setupStatus: 'failed',
        setupErrorCode: 'register_rate_limited',
      });
      expect(
        Date.parse(row.setupNextAttemptAt!) - before,
      ).toBeGreaterThanOrEqual(72 * 60 * 60_000 - 1_000);
    });
  });

  describe('number path', () => {
    it('never registers a Coexistence number', async () => {
      const state = defaultSetupState();
      state.phones[FAKE_PHONE_NUMBER_ID] = {
        is_on_biz_app: true,
        platform_type: 'CLOUD_API',
      };
      const h = harness({ state, row: { signupPath: 'coexistence' } });
      await run(h);
      expect(calls(h, 'POST', /\/register$/)).toHaveLength(0);
      expect(h.connections.get(h.row.id)).toMatchObject({
        state: 'verifying',
        setupStatus: 'complete',
        providerIsOnBizApp: true,
        providerPlatformType: 'CLOUD_API',
        registrationPinEncrypted: null,
        registeredAt: null,
      });
    });

    it('refuses when the browser said new number but Meta shows the Business app', async () => {
      const state = defaultSetupState();
      state.phones[FAKE_PHONE_NUMBER_ID] = {
        is_on_biz_app: true,
        platform_type: 'CLOUD_API',
      };
      const h = harness({ state, row: { signupPath: 'new_number' } });
      await run(h);
      expect(calls(h, 'POST', /\/register$/)).toHaveLength(0);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'exhausted',
        setupErrorCode: 'path_mismatch',
        providerIsOnBizApp: true,
      });
    });

    it('refuses when Meta does not say whether the number is on the Business app', async () => {
      const state = defaultSetupState();
      state.phones[FAKE_PHONE_NUMBER_ID] = { platform_type: 'NOT_APPLICABLE' };
      const h = harness({ state });
      await run(h);
      expect(calls(h, 'POST', /\/register$/)).toHaveLength(0);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'exhausted',
        setupErrorCode: 'path_unverified',
      });
    });

    it('refuses a number that is no longer in the account', async () => {
      const state = defaultSetupState();
      state.phoneNumbersByWaba[FAKE_WABA_ID] = [];
      const h = harness({ state });
      await run(h);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'exhausted',
        setupErrorCode: 'number_not_in_account',
      });
    });
  });

  describe('resuming and fencing', () => {
    it('resumes at the step that failed', async () => {
      const state = defaultSetupState();
      state.failures.phone_numbers = [{ kind: 'network' }];
      const h = harness({ state });
      await run(h);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'failed',
        setupStep: 'verify_number',
        setupErrorCode: 'number_unavailable',
      });
      h.connections.makeDue(h.row.id);
      await run(h);
      expect(calls(h, 'GET', /\/subscribed_apps$/)).toHaveLength(1);
      expect(h.connections.get(h.row.id).setupStatus).toBe('complete');
    });

    it('does nothing for a job from a replaced signup', async () => {
      const h = harness({ row: { signupGeneration: 2 } });
      await expect(h.service.run(h.row.id, 1)).resolves.toBe(false);
      expect(h.meta.requests).toHaveLength(0);
    });

    it('does nothing for a disconnected connection', async () => {
      const h = harness({
        row: { state: 'disconnected', businessTokenEncrypted: null },
      });
      await expect(run(h)).resolves.toBe(false);
      expect(h.meta.requests).toHaveLength(0);
    });

    it('lets one of two workers claim the same setup', async () => {
      const h = harness();
      const results = await Promise.all([run(h), run(h)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(calls(h, 'POST', /\/register$/)).toHaveLength(1);
    });

    it('stops writing once a newer signup replaces the row mid-attempt', async () => {
      const h = harness();
      const original = h.meta.fetch;
      h.fetchSpy.mockImplementation((async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const response = await original(input, init);
        if (
          (init?.method ?? 'GET') === 'POST' &&
          href(input).endsWith('/subscribed_apps')
        )
          h.connections.get(h.row.id).signupGeneration = 2;
        return response;
      }) as typeof fetch);
      await run(h);
      expect(calls(h, 'GET', /\/phone_numbers$/)).toHaveLength(0);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStep: 'subscribe',
        subscribedAt: null,
      });
      expect(logs.join('\n')).toContain('claim_lost');
    });

    it('stops for staff when the stored token cannot be read', async () => {
      const h = harness({
        row: { businessTokenEncrypted: 'v1:not-a-real-envelope' },
      });
      await run(h);
      expect(h.meta.requests).toHaveLength(0);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'exhausted',
        setupErrorCode: 'credentials_unreadable',
      });
    });

    it('backs off and stops after the attempt cap', async () => {
      const state = defaultSetupState();
      state.failures.subscribed_apps_read = Array.from({ length: 10 }, () => ({
        kind: 'network' as const,
      }));
      const h = harness({ state });
      await runToRest(h);
      expect(calls(h, 'GET', /\/subscribed_apps$/)).toHaveLength(6);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'exhausted',
        setupErrorCode: 'subscription_unavailable',
      });
    });

    it('refuses without retrying when Meta rejects the subscription', async () => {
      const state = defaultSetupState();
      state.failures.subscribed_apps_read = [
        { kind: 'meta_error', httpStatus: 403, code: 200 },
      ];
      const h = harness({ state });
      await run(h);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'exhausted',
        setupErrorCode: 'subscription_rejected',
      });
    });

    it('fails safely when the Meta app id is not configured', async () => {
      const h = harness();
      (h.service as unknown as { config: ConfigService }).config =
        new ConfigService({
          SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY,
        });
      await run(h);
      expect(h.meta.requests).toHaveLength(0);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'failed',
        setupErrorCode: 'subscription_unavailable',
      });
    });
  });

  describe('sweep', () => {
    it('queues every due setup with its generation, including one whose signup could not queue it', async () => {
      const h = harness({ row: { signupGeneration: 3 } });
      await expect(h.service.sweep()).resolves.toBe(1);
      expect(h.producer.enqueueSetup).toHaveBeenCalledWith('conn-1', 3);
    });

    it('picks up a setup whose worker died, once its lease runs out', async () => {
      const h = harness({
        row: {
          setupStatus: 'running',
          setupAttempts: 1,
          setupLeaseUntil: new Date(Date.now() - 1_000).toISOString(),
        },
      });
      await expect(h.service.sweep()).resolves.toBe(1);
      await run(h);
      expect(h.connections.get(h.row.id).setupStatus).toBe('complete');
    });

    it('leaves a setup alone while its lease holds', async () => {
      const h = harness({
        row: {
          setupStatus: 'running',
          setupAttempts: 1,
          setupLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      await expect(h.service.sweep()).resolves.toBe(0);
      await expect(run(h)).resolves.toBe(false);
    });
  });

  describe('provisioning inside setup', () => {
    it('paces submissions with the configured pause', async () => {
      const h = harness();
      await run(h);
      expect(h.templates.pauses).toEqual([1500]);
    });

    it('submits in batches and continues later until settled', async () => {
      const h = harness({
        env: { WHATSAPP_OWN_NUMBER_TEMPLATE_BATCH_SIZE: '1' },
      });
      await run(h);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'pending',
        setupStep: 'provision',
      });
      expect(h.producer.enqueueSetup).toHaveBeenCalledWith(
        'conn-1',
        1,
        expect.any(Number),
      );
      h.connections.makeDue(h.row.id);
      await run(h);
      expect(calls(h, 'POST', /\/message_templates$/)).toHaveLength(2);
      expect(h.connections.get(h.row.id).setupStatus).toBe('complete');
    });

    it('resumes after a create whose answer was lost, checking the list before sending again', async () => {
      const state = defaultSetupState();
      state.failures.template_create = [{ kind: 'network' }];
      const h = harness({ state });
      await run(h);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({
        status: 'unresolved',
      });
      expect(h.rows.byTemplate('tpl-eg')).toMatchObject({ status: 'pending' });
      expect(h.connections.get(h.row.id).setupStatus).toBe('pending');

      h.connections.makeDue(h.row.id);
      await run(h);
      const englishCreates = calls(h, 'POST', /\/message_templates$/).filter(
        (r) => (r.body as { language: string }).language === 'en',
      );
      expect(englishCreates).toHaveLength(2);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({ status: 'pending' });
      expect(h.connections.get(h.row.id).setupStatus).toBe('complete');
    });

    it('fails setup for a retry when the account templates cannot be listed', async () => {
      const state = defaultSetupState();
      state.failures.templates_list = [
        { kind: 'server_error', httpStatus: 500 },
      ];
      const h = harness({ state });
      await run(h);
      expect(h.connections.get(h.row.id)).toMatchObject({
        setupStatus: 'failed',
        setupStep: 'provision',
        setupErrorCode: 'templates_unavailable',
      });
    });
  });
});
