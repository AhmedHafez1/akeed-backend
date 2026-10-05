import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import request from 'supertest';
import { TemplateStatusService } from '../../../modules/template-registry/template-status.service';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../../../shared/config/whatsapp-template.config';
import { MetaWebhookSignatureGuard } from '../../../shared/guards/meta-webhook-signature.guard';
import { MetaTemplateWebhookHandler } from './meta-template-webhook.handler';
import { WhatsAppWebhookController } from './whatsapp.webhook.controller';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';

const APP_SECRET = 'synthetic-app-secret';
const ACCOUNT_ID = '100000000000001';

function fixture(name: string): string {
  const parsed = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../../test/fixtures/whatsapp-templates/webhooks',
        `${name}.json`,
      ),
      'utf8',
    ),
  ) as { payload: unknown };
  return JSON.stringify(parsed.payload);
}

/**
 * The WhatsApp webhook route as `main.ts` assembles it: raw body on, the
 * app-wide ValidationPipe, and the real signature guard. Template fields are
 * signed like message events, and the message path sees what it saw before.
 */
describe('WhatsApp webhook route with template fields (US-08-04)', () => {
  let app: INestApplication;
  const messages = {
    processIncoming: jest.fn().mockResolvedValue({ status: 'success' }),
  };
  const templateStatus = { applyEvents: jest.fn().mockResolvedValue({}) };
  const templates = parseWhatsappTemplateConfig({
    WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
    WA_BUSINESS_ACCOUNT_ID: ACCOUNT_ID,
  });

  const sign = (body: string) =>
    `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  const post = (body: string, signature = sign(body)) =>
    request(app.getHttpServer() as Server)
      .post('/webhooks/whatsapp')
      .set({
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature,
      })
      .send(body);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WhatsAppWebhookController],
      providers: [
        MetaWebhookSignatureGuard,
        MetaTemplateWebhookHandler,
        { provide: WhatsAppWebhookService, useValue: messages },
        { provide: TemplateStatusService, useValue: templateStatus },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'META_APP_SECRET'
                ? APP_SECRET
                : key === WHATSAPP_TEMPLATE_CONFIG
                  ? templates
                  : undefined,
            getOrThrow: (key: string) => {
              if (key === 'META_APP_SECRET') return APP_SECRET;
              throw new Error(`Unexpected config ${key}`);
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true, logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
      }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => jest.clearAllMocks());

  it('rejects a template delivery with an invalid signature before anything reads it', async () => {
    const body = fixture('status-paused');

    await post(body, 'sha256=' + '0'.repeat(64)).expect(401);

    expect(messages.processIncoming).not.toHaveBeenCalled();
    expect(templateStatus.applyEvents).not.toHaveBeenCalled();
  });

  it('rejects a template delivery with no signature', async () => {
    await request(app.getHttpServer() as Server)
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .send(fixture('status-paused'))
      .expect(401);

    expect(templateStatus.applyEvents).not.toHaveBeenCalled();
  });

  it.each([
    ['status-paused', { field: 'status', status: 'paused' }],
    ['quality-red', { field: 'quality', quality: 'low' }],
    ['category-completed', { field: 'category', category: 'marketing' }],
  ])(
    'routes a signed %s delivery to the registry and answers 200',
    async (name, expected) => {
      await post(fixture(name)).expect(200, { status: 'success' });

      expect(templateStatus.applyEvents).toHaveBeenCalledWith([
        expect.objectContaining({
          ...expected,
          templateName: 'akeed_cod_verification_friendly',
          languageCode: 'ar',
        }),
      ]);
    },
  );

  it('answers 200 even when applying the template event fails', async () => {
    templateStatus.applyEvents.mockRejectedValueOnce(new Error('db down'));

    await post(fixture('status-paused')).expect(200, { status: 'success' });
  });

  it('hands a messages delivery to the message service as before, and nothing to the registry', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 1767268800,
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.reply',
                    from: '201001112223',
                    type: 'button',
                    button: { payload: 'confirm_ver-1' },
                    context: { id: 'wamid.template' },
                  },
                ],
                statuses: [{ id: 'wamid.template', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    });

    await post(body).expect(200, { status: 'success' });

    expect(messages.processIncoming).toHaveBeenCalledTimes(1);
    const [payload] = messages.processIncoming.mock.calls[0] as [
      { entry: { changes: { value: Record<string, unknown> }[] }[] },
    ];
    expect(payload.entry[0].changes[0].value).toMatchObject({
      messages: [
        {
          id: 'wamid.reply',
          type: 'button',
          button: { payload: 'confirm_ver-1' },
          context: { id: 'wamid.template' },
        },
      ],
      statuses: [{ id: 'wamid.template', status: 'delivered' }],
    });
    expect(templateStatus.applyEvents).not.toHaveBeenCalled();
  });
});
