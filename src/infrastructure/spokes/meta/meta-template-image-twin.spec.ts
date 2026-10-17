import { Logger } from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { parseWhatsappTemplateConfig } from '../../../shared/config/whatsapp-template.config';
import type { ImageTwinSubmission } from '../../../shared/messaging/template-draft.types';
import { TemplateSubmissionError } from '../../../shared/ports/template-catalog.port';
import { MetaTemplateCatalogAdapter } from './meta-template-catalog.adapter';
import { buildMetaImageTwinBody } from './meta-template-components.builder';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

const TOKEN = 'test-token-not-real';
const ACCOUNT = '100000000000001';
const APP = '200000000000002';

const SUBMISSION: ImageTwinSubmission = {
  templateName: 'akeed_cod_verification_friendly_logo',
  languageCode: 'ar_EG',
  category: 'utility',
  parameterFormat: 'named',
  body: [
    { text: 'Hi ' },
    { parameter: 'customer_name' },
    { text: ', order ' },
    { parameter: 'order_number' },
  ],
  footer: [{ text: 'Akeed' }],
  samples: [
    { parameter: 'customer_name', sample: 'Ahmed' },
    { parameter: 'order_number', sample: 'TEST-1' },
  ],
  buttons: [
    { kind: 'quick_reply', text: 'Confirm' },
    { kind: 'quick_reply', text: 'Cancel' },
  ],
  headerHandle: '4::aW1hZ2UvanBlZw==:ARZ',
};

function setup(env: Record<string, string> = { META_APP_ID: APP }) {
  const values: Record<string, unknown> = {
    WA_ACCESS_TOKEN: TOKEN,
    whatsappTemplates: parseWhatsappTemplateConfig({
      WA_BUSINESS_ACCOUNT_ID: ACCOUNT,
      ...env,
    }),
  };
  const httpService = { post: jest.fn(), get: jest.fn() };
  const adapter = new MetaTemplateCatalogAdapter(
    httpService as never,
    { get: (key: string) => values[key] } as never,
  );
  return { adapter, httpService };
}

function refusal(status: number, code?: number) {
  return new AxiosError('refused', 'ERR', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: code === undefined ? {} : { error: { code } },
  });
}

async function failure(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof TemplateSubmissionError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('buildMetaImageTwinBody', () => {
  it('writes an IMAGE header, the body with examples, the footer and the quick replies', () => {
    expect(buildMetaImageTwinBody(SUBMISSION)).toEqual({
      name: 'akeed_cod_verification_friendly_logo',
      language: 'ar_EG',
      category: 'UTILITY',
      parameter_format: 'NAMED',
      components: [
        {
          type: 'HEADER',
          format: 'IMAGE',
          example: { header_handle: ['4::aW1hZ2UvanBlZw==:ARZ'] },
        },
        {
          type: 'BODY',
          text: 'Hi {{customer_name}}, order {{order_number}}',
          example: {
            body_text_named_params: [
              { param_name: 'customer_name', example: 'Ahmed' },
              { param_name: 'order_number', example: 'TEST-1' },
            ],
          },
        },
        { type: 'FOOTER', text: 'Akeed' },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Confirm' },
            { type: 'QUICK_REPLY', text: 'Cancel' },
          ],
        },
      ],
    });
  });

  it('writes positional examples and no footer when there is none', () => {
    const body = buildMetaImageTwinBody({
      ...SUBMISSION,
      parameterFormat: 'positional',
      body: [{ text: 'Order ' }, { parameter: '1' }],
      samples: [{ parameter: '1', sample: 'TEST-1' }],
      footer: undefined,
    });
    expect(body?.parameter_format).toBe('POSITIONAL');
    expect(body?.components).toEqual([
      expect.objectContaining({ type: 'HEADER' }),
      {
        type: 'BODY',
        text: 'Order {{1}}',
        example: { body_text: [['TEST-1']] },
      },
      expect.objectContaining({ type: 'BUTTONS' }),
    ]);
  });

  it('sends no parameter format and no example for a body without parameters', () => {
    const body = buildMetaImageTwinBody({
      ...SUBMISSION,
      parameterFormat: 'none',
      body: [{ text: 'Hello' }],
      samples: [],
    });
    expect(body).not.toHaveProperty('parameter_format');
    expect(body?.components).toContainEqual({ type: 'BODY', text: 'Hello' });
  });

  it('refuses an unknown category', () => {
    expect(
      buildMetaImageTwinBody({ ...SUBMISSION, category: 'unknown' }),
    ).toBeNull();
  });
});

describe('MetaTemplateCatalogAdapter image twins', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('uploads in two calls with the token only in headers', async () => {
    const { adapter, httpService } = setup();
    httpService.post
      .mockReturnValueOnce(of({ data: { id: 'upload:MTphdHRhY2htZW50' } }))
      .mockReturnValueOnce(of({ data: { h: '4::handle' } }));
    const bytes = Buffer.from('jpeg bytes');

    await expect(adapter.uploadSampleImage(bytes, 'image/jpeg')).resolves.toBe(
      '4::handle',
    );

    const [openUrl, openBody, openOptions] = httpService.post.mock.calls[0];
    expect(openUrl).toBe(`https://graph.facebook.com/v24.0/${APP}/uploads`);
    expect(openBody).toBeNull();
    expect(openOptions.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(openOptions.params).toEqual({
      file_name: 'akeed-logo-sample.jpg',
      file_length: bytes.byteLength,
      file_type: 'image/jpeg',
    });
    const [sendUrl, sendBody, sendOptions] = httpService.post.mock.calls[1];
    expect(sendUrl).toBe(
      'https://graph.facebook.com/v24.0/upload:MTphdHRhY2htZW50',
    );
    expect(sendBody).toBe(bytes);
    expect(sendOptions.headers).toEqual({
      Authorization: `OAuth ${TOKEN}`,
      file_offset: '0',
      'Content-Type': 'image/jpeg',
    });
    for (const [url] of httpService.post.mock.calls) {
      expect(String(url)).not.toContain(TOKEN);
    }
  });

  it('is not configured without META_APP_ID and sends nothing', async () => {
    const { adapter, httpService } = setup({});
    const error = await failure(
      adapter.uploadSampleImage(Buffer.from('x'), 'image/jpeg'),
    );
    expect(error.code).toBe('not_configured');
    expect(httpService.post).not.toHaveBeenCalled();
  });

  it('refuses a session id it cannot put in a path, and does not retry', async () => {
    const { adapter, httpService } = setup();
    httpService.post.mockReturnValueOnce(of({ data: { id: '../../me' } }));
    const error = await failure(
      adapter.uploadSampleImage(Buffer.from('x'), 'image/jpeg'),
    );
    expect(error.code).toBe('unresolved');
    expect(httpService.post).toHaveBeenCalledTimes(1);
  });

  it('classifies a refused upload like any write', async () => {
    const { adapter, httpService } = setup();
    httpService.post.mockReturnValueOnce(throwError(() => refusal(400, 190)));
    const error = await failure(
      adapter.uploadSampleImage(Buffer.from('x'), 'image/jpeg'),
    );
    expect(error.ambiguous).toBe(false);
    expect(httpService.post).toHaveBeenCalledTimes(1);
  });

  it('creates a twin once, on the account, and returns its id', async () => {
    const { adapter, httpService } = setup();
    httpService.post.mockReturnValueOnce(
      of({ data: { id: '987', status: 'PENDING', category: 'UTILITY' } }),
    );
    await expect(adapter.createImageTwin(SUBMISSION)).resolves.toEqual({
      providerTemplateId: '987',
      status: 'pending',
      category: 'utility',
    });
    const [url, body] = httpService.post.mock.calls[0];
    expect(url).toBe(
      `https://graph.facebook.com/v24.0/${ACCOUNT}/message_templates`,
    );
    expect(body).toEqual(buildMetaImageTwinBody(SUBMISSION));
  });

  it('reports a create with no readable answer as ambiguous', async () => {
    const { adapter, httpService } = setup();
    httpService.post.mockReturnValueOnce(throwError(() => refusal(503)));
    const error = await failure(adapter.createImageTwin(SUBMISSION));
    expect(error.code).toBe('unresolved');
    expect(error.ambiguous).toBe(true);
    expect(httpService.post).toHaveBeenCalledTimes(1);
  });
});
