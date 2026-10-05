import { Logger } from '@nestjs/common';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  FakeMetaTemplateApi,
  type FakeMetaTemplate,
  akeedTemplates,
  codComponents,
} from '../../../../test/contracts/meta-template-api-fake';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TemplateCatalogError } from '../../../shared/ports/template-catalog.port';
import { parseWhatsappTemplateConfig } from '../../../shared/config/whatsapp-template.config';
import { MetaTemplateCatalogAdapter } from './meta-template-catalog.adapter';

function setup(
  api = new FakeMetaTemplateApi(),
  env: Record<string, string> = {},
) {
  const values: Record<string, unknown> = {
    WA_ACCESS_TOKEN: FAKE_TOKEN,
    whatsappTemplates: parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
      WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
      ...env,
    }),
  };
  const adapter = new MetaTemplateCatalogAdapter(
    api.httpService as never,
    { get: (key: string) => values[key] } as never,
  );
  return { adapter, api, values };
}

/** The list response captured from the dev app, sanitized (US-08-01). */
function capturedTemplates(): FakeMetaTemplate[] {
  const fixture = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../../test/fixtures/whatsapp-templates/template-list.json',
      ),
      'utf8',
    ),
  ) as { payload: { data: FakeMetaTemplate[] } };
  return fixture.payload.data;
}

async function failure(
  promise: Promise<unknown>,
): Promise<TemplateCatalogError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TemplateCatalogError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('MetaTemplateCatalogAdapter', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  function logged(): string {
    return warn.mock.calls.map(([line]) => String(line)).join('\n');
  }

  it('lists every template as neutral records, sending the token only in the header', async () => {
    const { adapter, api } = setup();

    const records = await adapter.listTemplates();

    expect(records).toHaveLength(8);
    expect(records[1]).toEqual({
      providerTemplateId: '900000000000002',
      templateName: 'akeed_cod_verification_direct_eg',
      languageCode: 'ar_EG',
      status: 'approved',
      category: 'utility',
      pendingCategory: null,
      quality: 'high',
      components: {
        body: 'Synthetic body 2 {{1}}',
        buttons: [
          { kind: 'quick_reply', text: 'Synthetic confirm' },
          { kind: 'quick_reply', text: 'Synthetic cancel' },
        ],
      },
    });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toEqual({
      url: `https://graph.facebook.com/v24.0/${FAKE_ACCOUNT_ID}/message_templates`,
      authorization: `Bearer ${FAKE_TOKEN}`,
      params: {
        fields:
          'id,name,language,status,category,correct_category,quality_score,components',
        limit: 100,
      },
    });
    expect(api.requests[0].url).not.toContain(FAKE_TOKEN);
  });

  it.each([
    ['APPROVED', 'approved'],
    ['IN_APPEAL', 'in_appeal'],
    ['PENDING', 'pending'],
    ['REJECTED', 'rejected'],
    ['PENDING_DELETION', 'pending_deletion'],
    ['DELETED', 'deleted'],
    ['DISABLED', 'disabled'],
    ['PAUSED', 'paused'],
    ['LIMIT_EXCEEDED', 'limit_exceeded'],
    ['ARCHIVED', 'archived'],
    ['SOMETHING_NEW', 'unknown'],
  ])('maps a listed %s template to %s', async (status, neutral) => {
    const [template] = akeedTemplates();
    const { adapter } = setup(
      new FakeMetaTemplateApi({ templates: [{ ...template, status }] }),
    );

    await expect(adapter.listTemplates()).resolves.toEqual([
      expect.objectContaining({ status: neutral }),
    ]);
  });

  it.each([
    ['UTILITY', 'utility'],
    ['MARKETING', 'marketing'],
    ['AUTHENTICATION', 'authentication'],
    ['TRANSACTIONAL', 'unknown'],
  ])('maps category %s to %s', async (category, neutral) => {
    const [template] = akeedTemplates();
    const { adapter } = setup(
      new FakeMetaTemplateApi({ templates: [{ ...template, category }] }),
    );

    await expect(adapter.listTemplates()).resolves.toEqual([
      expect.objectContaining({ category: neutral }),
    ]);
  });

  it.each([
    ['GREEN', 'high'],
    ['YELLOW', 'medium'],
    ['RED', 'low'],
    ['UNKNOWN', 'pending'],
    [{ score: 'GREEN', date: 1 }, 'high'],
    [{ score: 'PURPLE', date: 1 }, 'unknown'],
    [undefined, 'unknown'],
  ])('maps quality %p to %s', async (quality_score, neutral) => {
    const [template] = akeedTemplates();
    const { adapter } = setup(
      new FakeMetaTemplateApi({ templates: [{ ...template, quality_score }] }),
    );

    await expect(adapter.listTemplates()).resolves.toEqual([
      expect.objectContaining({ quality: neutral }),
    ]);
  });

  it('reads the list response captured from the dev app (US-08-01)', async () => {
    const { adapter } = setup(
      new FakeMetaTemplateApi({
        templates: capturedTemplates(),
      }),
    );

    const records = await adapter.listTemplates();

    expect(records).toHaveLength(9);
    expect(
      records.every(
        (record) =>
          record.status === 'approved' &&
          record.category === 'utility' &&
          record.pendingCategory === null &&
          record.quality === 'pending' &&
          !('unknown' in record.components),
      ),
    ).toBe(true);
    const short = records.find(
      (record) =>
        record.templateName === 'akeed_cod_verification' &&
        record.languageCode === 'en',
    );
    expect(short?.components).toEqual({
      body: [
        'Hello',
        '',
        'We have received your order {{1}} with Cash on Delivery.',
        'Total Price : {{2}}',
        '',
        'Please confirm your order.',
      ].join('\n'),
      buttons: [
        { kind: 'quick_reply', text: 'Confirm' },
        { kind: 'quick_reply', text: 'Cancel' },
      ],
    });
    expect(adapter.describeComponents(short?.components ?? null)).toMatchObject(
      { format: 'positional' },
    );
  });

  it('reads a coming category change, and ignores one equal to the current category', async () => {
    const [first, second] = akeedTemplates();
    const { adapter } = setup(
      new FakeMetaTemplateApi({
        templates: [
          { ...first, correct_category: 'MARKETING' },
          { ...second, correct_category: 'UTILITY' },
        ],
      }),
    );

    const records = await adapter.listTemplates();

    expect(records.map((record) => record.pendingCategory)).toEqual([
      'marketing',
      null,
    ]);
  });

  it('keeps unreadable components as unknown', async () => {
    const [template] = akeedTemplates();
    const { adapter } = setup(
      new FakeMetaTemplateApi({
        templates: [{ ...template, components: { body: 'not a list' } }],
      }),
    );

    await expect(adapter.listTemplates()).resolves.toEqual([
      expect.objectContaining({ components: { unknown: true } }),
    ]);
  });

  it('follows pages with the after cursor only, never the next URL', async () => {
    const templates = [
      ...akeedTemplates(),
      ...Array.from({ length: 4 }, (_unused, index) => ({
        id: String(910000000000000 + index),
        name: `other_template_${index}`,
        language: 'en_US',
        status: 'APPROVED',
        category: 'MARKETING',
        quality_score: 'UNKNOWN',
        components: codComponents('Other'),
      })),
    ];
    const api = new FakeMetaTemplateApi({ templates, pageSize: 5 });
    const { adapter } = setup(api);

    const records = await adapter.listTemplates();

    expect(records).toHaveLength(12);
    expect(api.requests.map((request) => request.params.after)).toEqual([
      undefined,
      '5',
      '10',
    ]);
    expect(api.requests.every((request) => !request.url.includes('?'))).toBe(
      true,
    );
  });

  it('stops at the page cap instead of looping', async () => {
    const templates = Array.from({ length: 70 }, (_unused, index) => ({
      ...akeedTemplates()[0],
      id: String(920000000000000 + index),
      name: `bulk_${index}`,
    }));
    const api = new FakeMetaTemplateApi({ templates, pageSize: 1 });
    const { adapter } = setup(api);

    await expect(failure(adapter.listTemplates())).resolves.toMatchObject({
      code: 'too_many_pages',
    });
    expect(api.requests).toHaveLength(60);
  });

  it.each([
    [4, 'rate_limited'],
    [80007, 'rate_limited'],
    [80008, 'rate_limited'],
    [190, 'auth_failed'],
    [10, 'permission_denied'],
    [200, 'permission_denied'],
    [100, 'provider_error'],
    [131009, 'provider_error'],
  ])(
    'maps Meta error %i to %s without the token in the log',
    async (code, neutral) => {
      const api = new FakeMetaTemplateApi().failOnPage(1, {
        kind: 'meta_error',
        httpStatus: 400,
        code,
      });
      const { adapter } = setup(api);

      const error = await failure(adapter.listTemplates());

      expect(error.code).toBe(neutral);
      expect(error.providerCode).toBe(code);
      expect(error.message).not.toContain(FAKE_TOKEN);
      expect(logged()).toContain(`"errorCode":"${neutral}"`);
      expect(logged()).not.toContain(FAKE_TOKEN);
      expect(logged()).not.toContain('Synthetic failure');
    },
  );

  it('fails the whole read on a rate limit mid-pagination, after one request for that page', async () => {
    const api = new FakeMetaTemplateApi({ pageSize: 3 }).failOnPage(2, {
      kind: 'meta_error',
      httpStatus: 400,
      code: 80007,
    });
    const { adapter } = setup(api);

    await expect(failure(adapter.listTemplates())).resolves.toMatchObject({
      code: 'rate_limited',
    });
    expect(api.requests).toHaveLength(2);
    expect(logged()).toContain('"page":2');
  });

  it.each([
    [
      'an outage page',
      { kind: 'server_error', httpStatus: 503 } as const,
      'provider_error',
    ],
    ['a dropped connection', { kind: 'network' } as const, 'network'],
  ])(
    'reports %s without the token or the body',
    async (_label, failureCase, code) => {
      const api = new FakeMetaTemplateApi().failOnPage(1, failureCase);
      const { adapter } = setup(api);

      await expect(failure(adapter.listTemplates())).resolves.toMatchObject({
        code,
      });
      expect(logged()).not.toContain(FAKE_TOKEN);
      expect(logged()).not.toContain('Synthetic outage');
    },
  );

  it('refuses to call Meta without an account ID or a token', async () => {
    const { adapter, api, values } = setup(new FakeMetaTemplateApi(), {
      WHATSAPP_TEMPLATE_SYNC_ENABLED: 'false',
      WA_BUSINESS_ACCOUNT_ID: '',
    });

    await expect(failure(adapter.listTemplates())).resolves.toMatchObject({
      code: 'not_configured',
    });
    values.whatsappTemplates = parseWhatsappTemplateConfig({
      WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
    });
    values.WA_ACCESS_TOKEN = undefined;
    await expect(failure(adapter.listTemplates())).resolves.toMatchObject({
      code: 'not_configured',
    });
    expect(api.requests).toHaveLength(0);
  });
});
