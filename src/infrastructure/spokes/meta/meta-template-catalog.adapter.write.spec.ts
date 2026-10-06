import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  FakeMetaTemplateApi,
  type FakeMetaWriteFailure,
} from '../../../../test/contracts/meta-template-api-fake';
import { parseWhatsappTemplateConfig } from '../../../shared/config/whatsapp-template.config';
import type { TemplateDraftContent } from '../../../shared/messaging/template-draft.types';
import {
  buildTemplateName,
  toTemplateSubmission,
  validateTemplateDraft,
} from '../../../shared/messaging/template-draft.validation';
import {
  TemplateSubmissionError,
  type TemplateSubmissionErrorCode,
} from '../../../shared/ports/template-catalog.port';
import {
  META_TEMPLATE_WRITE_TIMEOUT_MS,
  MetaTemplateCatalogAdapter,
} from './meta-template-catalog.adapter';
import { mapComponents, mapRejectionReason } from './meta-template.mapping';

function setup(
  api = new FakeMetaTemplateApi(),
  env: Record<string, string> = {},
) {
  const values: Record<string, unknown> = {
    WA_ACCESS_TOKEN: FAKE_TOKEN,
    whatsappTemplates: parseWhatsappTemplateConfig({
      WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
      ...env,
    }),
  };
  const http = api.httpService;
  const post = jest.spyOn(http, 'post');
  const adapter = new MetaTemplateCatalogAdapter(
    http as never,
    { get: (key: string) => values[key] } as never,
  );
  return { adapter, api, values, post };
}

function draft(
  overrides: Partial<TemplateDraftContent> = {},
): TemplateDraftContent {
  return {
    purpose: 'cod_confirmation',
    language: 'en',
    style: 'warm',
    version: 1,
    templateName: buildTemplateName('cod_confirmation', 'warm', 1),
    languageCode: 'en',
    parameterFormat: 'named',
    category: 'utility',
    body: 'Hello {{customer}}, your order {{order}} from {{store}} comes to {{total}} in all today.',
    confirmLabel: 'Confirm order',
    cancelLabel: 'Cancel order',
    samples: {
      customer: 'Ahmed',
      store: 'Akeed Store',
      order: 'TEST-1',
      total: '250.00 USD',
    },
    ...overrides,
  };
}

async function failure(
  promise: Promise<unknown>,
): Promise<TemplateSubmissionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TemplateSubmissionError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('MetaTemplateCatalogAdapter create and edit (US-08-06 criterion 4)', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  const logged = () =>
    [...(warn.mock.calls as unknown[][]), ...(log.mock.calls as unknown[][])]
      .map(([line]) => String(line))
      .join('\n');

  it('creates a template once and returns its ID and first review status', async () => {
    const { adapter, api } = setup();

    const result = await adapter.createTemplate(toTemplateSubmission(draft()));

    expect(result).toEqual({
      providerTemplateId: '910000000000001',
      status: 'pending',
      category: 'utility',
    });
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]).toEqual({
      url: `https://graph.facebook.com/v24.0/${FAKE_ACCOUNT_ID}/message_templates`,
      authorization: `Bearer ${FAKE_TOKEN}`,
      body: {
        name: 'akeed_cod_confirm_warm_v1',
        language: 'en',
        category: 'UTILITY',
        parameter_format: 'NAMED',
        components: [
          {
            type: 'BODY',
            text: 'Hello {{customer}}, your order {{order}} from {{store}} comes to {{total}} in all today.',
            example: {
              body_text_named_params: [
                { param_name: 'customer', example: 'Ahmed' },
                { param_name: 'order', example: 'TEST-1' },
                { param_name: 'store', example: 'Akeed Store' },
                { param_name: 'total', example: '250.00 USD' },
              ],
            },
          },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'Confirm order' },
              { type: 'QUICK_REPLY', text: 'Cancel order' },
            ],
          },
        ],
      },
    });
    expect(api.writes[0].url).not.toContain(FAKE_TOKEN);
    expect(logged()).not.toContain(FAKE_TOKEN);
  });

  it('writes a positional body as {{1}}, {{2}} with a nested example list (record 4.6.4)', async () => {
    const { adapter, api } = setup();

    await adapter.createTemplate(
      toTemplateSubmission(
        draft({
          parameterFormat: 'positional',
          body: 'We received order {{order}} and it comes to {{total}} in all.',
          samples: { order: 'TEST-1', total: '250.00 USD' },
        }),
      ),
    );

    expect(api.writes[0].body).toMatchObject({
      parameter_format: 'POSITIONAL',
      components: [
        {
          type: 'BODY',
          text: 'We received order {{1}} and it comes to {{2}} in all.',
          example: { body_text: [['TEST-1', '250.00 USD']] },
        },
        { type: 'BUTTONS' },
      ],
    });
  });

  it('puts the confirm button first, which is index 0 at send time (record 4.7.6)', async () => {
    const { adapter, api } = setup();

    await adapter.createTemplate(toTemplateSubmission(draft()));

    const [template] = api.templates.slice(-1);
    expect(mapComponents(template.components)).toMatchObject({
      buttons: [
        { kind: 'quick_reply', text: 'Confirm order' },
        { kind: 'quick_reply', text: 'Cancel order' },
      ],
    });
  });

  it.each([
    ['APPROVED', 'approved'],
    ['PENDING', 'pending'],
    ['REJECTED', 'rejected'],
  ])(
    'reads a create answered %s as %s (record 4.2.2)',
    async (status, neutral) => {
      const { adapter, api } = setup();
      api.createStatus = status;

      await expect(
        adapter.createTemplate(toTemplateSubmission(draft())),
      ).resolves.toMatchObject({ status: neutral });
    },
  );

  it.each<[number, TemplateSubmissionErrorCode]>([
    [100, 'invalid_parameter'],
    [131009, 'invalid_parameter'],
    [139000, 'integrity_blocked'],
    [2388039, 'status_locked'],
    [2388040, 'character_limit'],
    [2388047, 'format_rejected'],
    [2388072, 'format_rejected'],
    [2388073, 'format_rejected'],
    [2388293, 'parameter_ratio'],
    [2388299, 'parameter_at_edge'],
    [190, 'auth_failed'],
    [10, 'permission_denied'],
    [200, 'permission_denied'],
    [4, 'rate_limited'],
    [80007, 'rate_limited'],
    [80008, 'rate_limited'],
    [999999, 'provider_error'],
  ])(
    'maps Graph code %d to %s, a refusal that is not ambiguous (record 4.1.11)',
    async (code, neutral) => {
      const { adapter, api } = setup();
      api.failNextWrite({ kind: 'meta_error', httpStatus: 400, code });

      const error = await failure(
        adapter.createTemplate(toTemplateSubmission(draft())),
      );

      expect(error).toMatchObject({
        code: neutral,
        ambiguous: false,
        providerCode: code,
        providerReference: 'synthetic-trace',
      });
      // The provider's message echoes the token; none of it is kept.
      expect(error.message).not.toContain(FAKE_TOKEN);
      expect(logged()).not.toContain(FAKE_TOKEN);
      expect(api.templates).toHaveLength(8);
    },
  );

  it.each<[string, FakeMetaWriteFailure]>([
    ['no answer', { kind: 'network' }],
    ['a 5xx', { kind: 'server_error', httpStatus: 503 }],
    [
      'a 5xx with a Graph code',
      { kind: 'meta_error', httpStatus: 500, code: 100 },
    ],
    ['an answer lost after it was applied', { kind: 'applied_then_lost' }],
  ])(
    'treats %s as unresolved and never sends it again',
    async (_case, fault) => {
      const { adapter, api } = setup();
      api.failNextWrite(fault);

      const error = await failure(
        adapter.createTemplate(toTemplateSubmission(draft())),
      );

      expect(error).toMatchObject({ code: 'unresolved', ambiguous: true });
      expect(api.writes).toHaveLength(1);
      expect(logged()).not.toContain(FAKE_TOKEN);
    },
  );

  it('sends one bounded attempt with the token in the header only', async () => {
    const { adapter, post } = setup();

    await adapter.createTemplate(toTemplateSubmission(draft()));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][2]).toEqual({
      headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
      timeout: META_TEMPLATE_WRITE_TIMEOUT_MS,
    });
  });

  it('refuses to write without the account ID or the token, sending nothing', async () => {
    const { adapter, api, values } = setup();
    values.WA_ACCESS_TOKEN = undefined;

    await expect(
      failure(adapter.createTemplate(toTemplateSubmission(draft()))),
    ).resolves.toMatchObject({ code: 'not_configured', ambiguous: false });
    expect(api.writes).toHaveLength(0);
  });

  it('refuses a category Meta has no value for, sending nothing', async () => {
    const { adapter, api } = setup();

    await expect(
      failure(
        adapter.createTemplate({
          ...toTemplateSubmission(draft()),
          category: 'unknown',
        }),
      ),
    ).resolves.toMatchObject({ code: 'invalid_parameter', ambiguous: false });
    expect(api.writes).toHaveLength(0);
  });

  describe('edit (record 4.1.4, 4.3.4)', () => {
    it('replaces every component of the template, and nothing else', async () => {
      const { adapter, api } = setup();
      const [template] = api.templates;

      await adapter.editTemplate(
        template.id,
        toTemplateSubmission(
          draft({
            body: 'Hi {{customer}}, order {{order}} is ready to confirm now.',
          }),
        ),
      );

      expect(api.writes).toEqual([
        {
          url: `https://graph.facebook.com/v24.0/${template.id}`,
          authorization: `Bearer ${FAKE_TOKEN}`,
          body: {
            components: [
              {
                type: 'BODY',
                text: 'Hi {{customer}}, order {{order}} is ready to confirm now.',
                example: {
                  body_text_named_params: [
                    { param_name: 'customer', example: 'Ahmed' },
                    { param_name: 'order', example: 'TEST-1' },
                  ],
                },
              },
              {
                type: 'BUTTONS',
                buttons: [
                  { type: 'QUICK_REPLY', text: 'Confirm order' },
                  { type: 'QUICK_REPLY', text: 'Cancel order' },
                ],
              },
            ],
          },
        },
      ]);
    });

    it('reports an edit Meta refuses with its neutral reason', async () => {
      const { adapter, api } = setup();
      api.failNextWrite({ kind: 'meta_error', httpStatus: 400, code: 2388039 });

      await expect(
        failure(
          adapter.editTemplate(
            api.templates[0].id,
            toTemplateSubmission(draft()),
          ),
        ),
      ).resolves.toMatchObject({ code: 'status_locked', ambiguous: false });
    });

    it('treats an edit with no answer as unresolved and does not repeat it', async () => {
      const { adapter, api } = setup();
      api.failNextWrite({ kind: 'applied_then_lost' });

      await expect(
        failure(
          adapter.editTemplate(
            api.templates[0].id,
            toTemplateSubmission(draft()),
          ),
        ),
      ).resolves.toMatchObject({ code: 'unresolved', ambiguous: true });
      expect(api.writes).toHaveLength(1);
    });

    it('refuses a template ID that is not a number, sending nothing', async () => {
      const { adapter, api } = setup();

      await expect(
        failure(adapter.editTemplate('../me', toTemplateSubmission(draft()))),
      ).resolves.toMatchObject({ code: 'invalid_parameter' });
      expect(api.writes).toHaveLength(0);
    });
  });

  describe('rejection reason (record 3.2, 4.8.8)', () => {
    it.each([
      ['ABUSIVE_CONTENT', 'abusive_content'],
      ['INCORRECT_CATEGORY', 'incorrect_category'],
      ['INVALID_FORMAT', 'invalid_format'],
      ['NONE', 'none'],
      ['PROMOTIONAL', 'promotional'],
      ['SCAM', 'scam'],
      ['TAG_CONTENT_MISMATCH', 'tag_content_mismatch'],
      ['CATEGORY_NOT_AVAILABLE', 'unknown'],
      ['SOMETHING_NEW', 'unknown'],
    ])('maps %s to %s', (value, neutral) => {
      expect(mapRejectionReason(value)).toBe(neutral);
    });

    it('is undefined when Meta sends none', () => {
      expect(mapRejectionReason(undefined)).toBeUndefined();
      expect(mapRejectionReason(null)).toBeUndefined();
    });

    it('lists a rejected template with its reason', async () => {
      const api = new FakeMetaTemplateApi();
      api.templates[0] = {
        ...api.templates[0],
        status: 'REJECTED',
        rejected_reason: 'INVALID_FORMAT',
      };
      const { adapter } = setup(api);

      const [record] = await adapter.listTemplates();

      expect(record).toMatchObject({
        status: 'rejected',
        rejectionReason: 'invalid_format',
      });
    });
  });

  /**
   * The dry run of the first real submission (US-08-06). The request below is
   * built by the real validation and the real adapter and is compared with
   * the fixture staff review before anything is sent to Meta. It reaches only
   * the in-process fake.
   */
  it('builds the first real submission exactly as the dry-run fixture records it', async () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          __dirname,
          '../../../../test/fixtures/whatsapp-templates/dry-run/first-submission.json',
        ),
        'utf8',
      ),
    ) as {
      _fixture: {
        draft: Omit<
          TemplateDraftContent,
          'templateName' | 'languageCode' | 'category'
        >;
      };
      request: Record<string, unknown>;
    };
    const { adapter, api, post } = setup();
    const content: TemplateDraftContent = {
      ...fixture._fixture.draft,
      templateName: buildTemplateName(
        fixture._fixture.draft.purpose,
        fixture._fixture.draft.style,
        fixture._fixture.draft.version,
      ),
      languageCode: 'en',
      category: 'utility',
    };
    const validation = validateTemplateDraft(content, {
      takenIdentities: new Set(),
    });
    expect(validation.issues).toEqual([]);

    await adapter.createTemplate(
      toTemplateSubmission(content, validation.variables),
    );

    const [write] = api.writes;
    expect(api.writes).toHaveLength(1);
    expect({
      method: 'POST',
      url: write.url.replace(FAKE_ACCOUNT_ID, '<WA_BUSINESS_ACCOUNT_ID>'),
      headers: {
        Authorization: write.authorization?.replace(
          FAKE_TOKEN,
          '<WA_ACCESS_TOKEN>',
        ),
      },
      timeoutMs: META_TEMPLATE_WRITE_TIMEOUT_MS,
      retries: post.mock.calls.length - 1,
      body: write.body,
    }).toEqual(fixture.request);
  });
});
