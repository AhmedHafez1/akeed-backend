import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import type { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import type {
  InspectedTemplate,
  WhatsappTemplatesRepository,
} from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import { OwnNumberGraphClient } from '../../infrastructure/spokes/meta/own-number/own-number-graph.client';
import { encryptConnectionSecret } from '../../infrastructure/spokes/meta/own-number/whatsapp-connection-credentials';
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
  FAKE_WABA_ID,
} from '../../../test/contracts/meta-signup-fake';
import {
  createMetaSetupFake,
  defaultSetupState,
  type FakeMetaSetupState,
  type FakeTemplateNode,
} from '../../../test/contracts/meta-own-number-setup-fake';
import {
  connectionRow,
  InMemoryConnections,
  InMemoryConnectionTemplates,
  registryFake,
} from '../../../test/fixtures/whatsapp-connection-setup.fakes';
import {
  inspected,
  TEXT,
} from '../../../test/fixtures/whatsapp-connection-setup.fixtures';
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
const AKEED_TOKEN = 'EAAG-akeed-shared-token-never-real';

/** TEXT as Meta lists it. */
const META_COMPONENTS = [
  { type: 'BODY', text: 'Hello {{customer}}, confirm order {{order}}?' },
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Confirm' },
      { type: 'QUICK_REPLY', text: 'Cancel' },
    ],
  },
];

class TestTemplatesService extends ConnectionTemplatesService {
  readonly pauses: number[] = [];
  protected pause(ms: number): Promise<void> {
    this.pauses.push(ms);
    return Promise.resolve();
  }
}

function listed(overrides: Partial<FakeTemplateNode> = {}): FakeTemplateNode {
  return {
    id: '7000000001',
    name: 'akeed_cod_verification_friendly',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    components: META_COMPONENTS,
    ...overrides,
  };
}

describe('ConnectionTemplatesService', () => {
  let logs: string[];

  function harness(
    options: {
      state?: FakeMetaSetupState;
      registry?: InspectedTemplate[];
      row?: Parameters<typeof connectionRow>[0];
      env?: Record<string, string>;
    } = {},
  ) {
    const meta = createMetaSetupFake(options.state ?? defaultSetupState());
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(meta.fetch as typeof fetch);
    const config = new ConfigService({
      WA_ACCESS_TOKEN: AKEED_TOKEN,
      WA_BUSINESS_ACCOUNT_ID: '100000000000001',
      SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY,
      [META_GRAPH_CONFIG]: parseMetaGraphConfig({}),
      [WHATSAPP_OWN_NUMBER_CONFIG]: parseWhatsappOwnNumberConfig({
        WHATSAPP_OWN_NUMBER_TEMPLATE_SUBMIT_INTERVAL_MS: '0',
        ...options.env,
      }),
    });
    const connections = new InMemoryConnections();
    const rows = new InMemoryConnectionTemplates();
    const registryTemplates = options.registry ?? [inspected()];
    const registry = registryFake(registryTemplates);
    const producer = {
      enqueueSetup: jest.fn().mockResolvedValue(true),
      requestTemplateSync: jest.fn().mockResolvedValue(true),
    };
    const service = new TestTemplatesService(
      config,
      connections as unknown as WhatsappConnectionsRepository,
      rows as unknown as WhatsappConnectionTemplatesRepository,
      registry as unknown as WhatsappTemplatesRepository,
      new OwnNumberGraphClient(config),
      producer as unknown as WhatsappConnectionSetupProducer,
    );
    const row = connections.add(
      connectionRow({
        state: 'verifying',
        setupStatus: 'complete',
        setupStep: 'done',
        numberVerifiedAt: new Date().toISOString(),
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
      registryTemplates,
      producer,
      service,
      row,
    };
  }

  type Harness = ReturnType<typeof harness>;
  const creates = (h: Harness) =>
    h.meta.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/message_templates'),
    );

  /** Meta holds `node` already, then answers the create as a duplicate. */
  function duplicateOnCreate(h: Harness, node: FakeTemplateNode | null) {
    const original = h.meta.fetch;
    h.fetchSpy.mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (
        (init?.method ?? 'GET') === 'POST' &&
        href(input).endsWith('/message_templates')
      ) {
        if (node) h.meta.state.templatesByWaba[FAKE_WABA_ID].push(node);
        else
          h.meta.state.failures.template_create = [
            {
              kind: 'meta_error_subcode',
              httpStatus: 400,
              code: 100,
              subcode: 2388024,
            },
          ];
      }
      return original(input, init);
    }) as typeof fetch);
  }

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

  it("uses the merchant account and token, never Akeed's", async () => {
    const h = harness();
    await h.service.syncConnection(h.row.id);
    expect(h.meta.requests.length).toBeGreaterThan(0);
    for (const request of h.meta.requests) {
      expect(request.path.startsWith(`/${FAKE_WABA_ID}/`)).toBe(true);
      expect(request.authorization).toBe(`Bearer ${FAKE_BUSINESS_TOKEN}`);
      expect(request.authorization).not.toContain(AKEED_TOKEN);
    }
  });

  describe('duplicates', () => {
    it('adopts a template Meta already holds with the registry text', async () => {
      const h = harness();
      duplicateOnCreate(h, listed({ status: 'APPROVED' }));
      await h.service.syncConnection(h.row.id);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({
        status: 'approved',
        metaTemplateId: '7000000001',
        submittedComponentsHash: expect.stringMatching(
          /^[0-9a-f]{64}$/,
        ) as string,
        driftAt: null,
      });
    });

    it('adopts other text for its status, marks it for staff and never overwrites it', async () => {
      const h = harness();
      duplicateOnCreate(
        h,
        listed({ components: [{ type: 'BODY', text: 'A merchant edit' }] }),
      );
      await h.service.syncConnection(h.row.id);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({
        status: 'approved',
        driftReason: 'provider_differs',
        submittedComponentsHash: null,
      });
      expect(creates(h)).toHaveLength(1);
      expect(
        h.meta.requests.some((r) => r.method !== 'GET' && r.method !== 'POST'),
      ).toBe(false);
    });

    it('does not take a duplicate answer as proof when the list does not show the template', async () => {
      const h = harness();
      duplicateOnCreate(h, null);
      await h.service.syncConnection(h.row.id);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({
        status: 'unresolved',
        lastErrorCode: 'duplicate_not_listed',
      });
    });
  });

  describe('reconciliation', () => {
    it('reads every page of the account, following the cursor and never the next URL', async () => {
      const state = defaultSetupState();
      state.pageSize = 2;
      state.templatesByWaba[FAKE_WABA_ID] = [
        listed({ id: '7000000011', name: 'merchant_one' }),
        listed({ id: '7000000012', name: 'merchant_two' }),
        listed({ id: '7000000013', name: 'merchant_three' }),
        listed({ id: '7000000014', name: 'merchant_four' }),
        listed({ id: '7000000001' }),
      ];
      const h = harness({ state });
      await h.service.syncConnection(h.row.id);
      const reads = h.meta.requests.filter(
        (r) => r.method === 'GET' && r.path.endsWith('/message_templates'),
      );
      expect(reads.map((r) => r.query.after ?? null)).toEqual([null, '2', '4']);
      expect(h.meta.requests.some((r) => r.path.includes('next'))).toBe(false);
      // Found on the last page, so nothing is created.
      expect(creates(h)).toHaveLength(0);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({ status: 'approved' });
    });

    it('changes nothing when a page fails part-way', async () => {
      const state = defaultSetupState();
      state.pageSize = 1;
      state.templatesByWaba[FAKE_WABA_ID] = [listed({ name: 'a' }), listed()];
      state.failures.templates_list = [];
      const h = harness({ state });
      const original = h.meta.fetch;
      let reads = 0;
      h.fetchSpy.mockImplementation((async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        if (
          (init?.method ?? 'GET') === 'GET' &&
          href(input).includes('/message_templates')
        ) {
          reads += 1;
          if (reads === 2) return new Response('x', { status: 502 });
        }
        return original(input, init);
      }) as typeof fetch);
      await expect(h.service.syncConnection(h.row.id)).resolves.toMatchObject({
        outcome: 'provider_unavailable',
      });
      expect(h.rows.rows).toHaveLength(0);
      expect(creates(h)).toHaveLength(0);
    });

    it('provisions a template that became live in the registry since setup', async () => {
      const h = harness();
      await h.service.syncConnection(h.row.id);
      h.registryTemplates.push(
        inspected({
          id: 'tpl-ur',
          key: 'cod_confirm.ur.standard_v1',
          language: 'ur',
          templateName: 'akeed_cod_confirm_standard_v1',
          languageCode: 'ur',
        }),
      );
      await h.service.syncConnection(h.row.id);
      expect(h.rows.byTemplate('tpl-ur')).toMatchObject({ status: 'pending' });
      expect(
        creates(h).map((r) => (r.body as { language: string }).language),
      ).toEqual(['en', 'ur']);
    });

    it('marks a registry edit for staff and does not resubmit', async () => {
      const h = harness();
      await h.service.syncConnection(h.row.id);
      h.meta.state.templatesByWaba[FAKE_WABA_ID][0].status = 'APPROVED';
      h.registryTemplates[0] = inspected(
        {},
        { ...TEXT, body: 'Hi {{customer}}, is order {{order}} right?' },
      );
      await h.service.syncConnection(h.row.id);
      expect(creates(h)).toHaveLength(1);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({
        status: 'approved',
        driftReason: 'registry_edited',
      });
      expect(logs.join('\n')).toContain('registry_edited');
    });

    it('sends again a template Meta no longer lists', async () => {
      const h = harness();
      await h.service.syncConnection(h.row.id);
      h.meta.state.templatesByWaba[FAKE_WABA_ID] = [];
      await h.service.syncConnection(h.row.id);
      expect(creates(h)).toHaveLength(2);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({ status: 'pending' });
    });

    it('keeps pending, rejected and paused templates as Meta reports them, none of them ready', async () => {
      for (const status of ['PENDING', 'REJECTED', 'PAUSED']) {
        const state = defaultSetupState();
        state.templatesByWaba[FAKE_WABA_ID] = [listed({ status })];
        const h = harness({ state });
        await h.service.syncConnection(h.row.id);
        expect(h.rows.byTemplate('tpl-en')?.status).toBe(status.toLowerCase());
        expect(creates(h)).toHaveLength(0);
        jest.restoreAllMocks();
        for (const level of ['log', 'warn', 'error'] as const)
          jest
            .spyOn(Logger.prototype, level)
            .mockImplementation(() => undefined);
      }
    });

    it('skips a connection that is disconnected or not yet verified', async () => {
      const disconnected = harness({
        row: { state: 'disconnected', businessTokenEncrypted: null },
      });
      await expect(
        disconnected.service.syncConnection(disconnected.row.id),
      ).resolves.toMatchObject({ outcome: 'skipped' });
      expect(disconnected.meta.requests).toHaveLength(0);
      jest.restoreAllMocks();
      const early = harness({
        row: { state: 'connecting', numberVerifiedAt: null },
      });
      await expect(
        early.service.syncConnection(early.row.id),
      ).resolves.toMatchObject({
        outcome: 'skipped',
      });
      expect(early.meta.requests).toHaveLength(0);
    });
  });

  describe('failures', () => {
    it('stops retrying text Meta refuses, and goes on with the next template', async () => {
      const state = defaultSetupState();
      state.failures.template_create = [
        { kind: 'meta_error', httpStatus: 400, code: 2388040 },
      ];
      const h = harness({
        state,
        registry: [
          inspected(),
          inspected({
            id: 'tpl-ar',
            key: 'cod_confirm.ar.standard',
            language: 'ar',
            languageCode: 'ar',
          }),
        ],
      });
      await h.service.syncConnection(h.row.id);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({
        status: 'exhausted',
        lastErrorCode: 'character_limit',
      });
      expect(h.rows.byTemplate('tpl-ar')).toMatchObject({ status: 'pending' });
    });

    it('stops the run when the token cannot manage templates, keeping a retry', async () => {
      const state = defaultSetupState();
      state.failures.template_create = [
        { kind: 'meta_error', httpStatus: 403, code: 200 },
      ];
      const h = harness({
        state,
        registry: [
          inspected(),
          inspected({
            id: 'tpl-ar',
            key: 'cod_confirm.ar.standard',
            language: 'ar',
            languageCode: 'ar',
          }),
        ],
      });
      await expect(h.service.syncConnection(h.row.id)).resolves.toMatchObject({
        outcome: 'credentials',
      });
      expect(creates(h)).toHaveLength(1);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({
        status: 'failed',
        lastErrorCode: 'permission_denied',
      });
      expect(h.rows.byTemplate('tpl-ar')).toMatchObject({
        status: 'not_submitted',
      });
    });

    it('waits an hour after a rate limit and queues itself to continue', async () => {
      const state = defaultSetupState();
      state.failures.template_create = [
        { kind: 'meta_error', httpStatus: 400, code: 80008 },
      ];
      const h = harness({ state });
      const before = Date.now();
      await expect(h.service.syncConnection(h.row.id)).resolves.toMatchObject({
        outcome: 'more',
      });
      const row = h.rows.byTemplate('tpl-en')!;
      expect(row).toMatchObject({
        status: 'failed',
        lastErrorCode: 'rate_limited',
      });
      expect(Date.parse(row.nextAttemptAt!) - before).toBeGreaterThanOrEqual(
        59 * 60_000,
      );
      expect(h.producer.requestTemplateSync).toHaveBeenCalledWith(
        h.row.id,
        expect.any(Number),
      );
    });

    it('marks text it cannot copy as incompatible and sends nothing', async () => {
      const h = harness({
        registry: [
          inspected(
            {},
            {
              body: 'Hello {{customer}}, order {{order}}',
              buttons: [{ kind: 'url', text: 'Track' }],
            },
          ),
        ],
      });
      await h.service.syncConnection(h.row.id);
      expect(creates(h)).toHaveLength(0);
      expect(h.rows.byTemplate('tpl-en')).toMatchObject({
        status: 'incompatible',
        lastErrorCode: 'non_quick_reply_button',
      });
    });

    it('keeps the template text out of logs', async () => {
      const h = harness();
      await h.service.syncConnection(h.row.id);
      const all = logs.join('\n');
      expect(all).not.toContain('confirm order');
      expect(all).not.toContain(FAKE_BUSINESS_TOKEN);
    });
  });

  it('keeps two accounts apart', async () => {
    const h = harness();
    const other = h.connections.add(
      connectionRow({
        id: 'conn-2',
        orgId: 'org-2',
        wabaId: '102290129349999',
        phoneNumberId: '106540352249999',
        state: 'verifying',
        numberVerifiedAt: new Date().toISOString(),
        businessTokenEncrypted: encryptConnectionSecret(
          FAKE_BUSINESS_TOKEN,
          KEY,
        ),
      }),
    );
    h.meta.state.templatesByWaba['102290129349999'] = [];
    await h.service.syncConnection(h.row.id);
    await h.service.syncConnection(other.id);
    const byOrg = (orgId: string) =>
      h.rows.rows.filter((r) => r.orgId === orgId);
    expect(byOrg('org-1')).toHaveLength(1);
    expect(byOrg('org-2')).toHaveLength(1);
    expect(byOrg('org-2')[0].connectionId).toBe('conn-2');
    expect(h.meta.state.templatesByWaba[FAKE_WABA_ID]).toHaveLength(1);
    expect(h.meta.state.templatesByWaba['102290129349999']).toHaveLength(1);
  });
});
