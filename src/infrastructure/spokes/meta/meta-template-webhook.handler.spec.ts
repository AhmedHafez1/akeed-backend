import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { parseWhatsappTemplateConfig } from '../../../shared/config/whatsapp-template.config';
import type { TemplateProviderEvent } from '../../../shared/messaging/template-provider.types';
import { MetaTemplateWebhookHandler } from './meta-template-webhook.handler';

const FIXTURES = resolve(
  __dirname,
  '../../../../test/fixtures/whatsapp-templates/webhooks',
);
const ACCOUNT_ID = '100000000000001';

function fixture(name: string): Record<string, unknown> {
  return (
    JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as {
      payload: Record<string, unknown>;
    }
  ).payload;
}

function body(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

function setup(env: Record<string, string> = {}) {
  const parsed = parseWhatsappTemplateConfig({
    WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
    WA_BUSINESS_ACCOUNT_ID: ACCOUNT_ID,
    ...env,
  });
  const templateStatus = { applyEvents: jest.fn().mockResolvedValue({}) };
  const handler = new MetaTemplateWebhookHandler(
    { get: () => parsed } as never,
    templateStatus as never,
  );
  return { handler, templateStatus };
}

describe('MetaTemplateWebhookHandler', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['status-approved', 'approved'],
    ['status-pending', 'pending'],
    ['status-rejected', 'rejected'],
    ['status-paused', 'paused'],
    ['status-disabled', 'disabled'],
    ['status-flagged', 'flagged'],
    ['status-in-appeal', 'in_appeal'],
    ['status-limit-exceeded', 'limit_exceeded'],
    ['status-locked', 'locked'],
    ['status-reinstated', 'reinstated'],
    ['status-pending-deletion', 'pending_deletion'],
    ['status-deleted', 'deleted'],
    ['status-archived', 'archived'],
    ['status-unarchived', 'unarchived'],
  ])('reads %s as a neutral %s status event', (name, status) => {
    const { handler } = setup();

    const [event] = handler.extract(body(fixture(name)));

    expect(event).toEqual<TemplateProviderEvent>({
      field: 'status',
      identityKey: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      occurredAt: expect.any(String) as string,
      templateName: 'akeed_cod_verification_friendly',
      languageCode: 'ar',
      providerTemplateId: '900000000000001',
      status: status as TemplateProviderEvent['status'],
      // The reason travels with every status event (record 4.8.8); a
      // scheduled deletion carries none.
      rejectionReason:
        name === 'status-rejected'
          ? 'invalid_format'
          : name === 'status-pending-deletion'
            ? null
            : 'none',
    });
  });

  it.each([
    ['quality-green', 'high'],
    ['quality-yellow', 'medium'],
    ['quality-red', 'low'],
    ['quality-unknown', 'pending'],
  ])('reads %s as a neutral %s quality event', (name, quality) => {
    const { handler } = setup();

    expect(handler.extract(body(fixture(name)))).toEqual([
      expect.objectContaining({ field: 'quality', quality }),
    ]);
  });

  it('reads a scheduled category change as the current category with the coming one pending', () => {
    const { handler } = setup();

    expect(handler.extract(body(fixture('category-impending')))).toEqual([
      expect.objectContaining({
        field: 'category',
        category: 'utility',
        pendingCategory: 'marketing',
        occurredAt: new Date(1767276000 * 1000).toISOString(),
      }),
    ]);
  });

  it('reads a completed category change as the new category', () => {
    const { handler } = setup();

    expect(handler.extract(body(fixture('category-completed')))).toEqual([
      expect.objectContaining({
        field: 'category',
        category: 'marketing',
        pendingCategory: null,
      }),
    ]);
  });

  it('covers every committed webhook fixture: components updates are not read', () => {
    const { handler } = setup();
    const names = readdirSync(FIXTURES).map((file) =>
      file.replace('.json', ''),
    );

    const read = names.filter(
      (name) => handler.extract(body(fixture(name))).length === 1,
    );

    expect(names).toHaveLength(21);
    expect(names.filter((name) => !read.includes(name))).toEqual([
      'components-update',
    ]);
  });

  it('maps an event value the record does not list to unknown', () => {
    const { handler } = setup();
    const payload = fixture('status-approved') as {
      entry: { changes: { value: Record<string, unknown> }[] }[];
    };
    payload.entry[0].changes[0].value.event = 'SOMETHING_NEW';

    expect(handler.extract(body(payload))).toEqual([
      expect.objectContaining({ status: 'unknown' }),
    ]);
  });

  it('gives a redelivery the same identity and a different delivery a different one', () => {
    const { handler } = setup();
    const [first] = handler.extract(body(fixture('status-paused')));
    const [again] = handler.extract(body(fixture('status-paused')));
    const [other] = handler.extract(body(fixture('status-approved')));

    expect(again.identityKey).toBe(first.identityKey);
    expect(other.identityKey).not.toBe(first.identityKey);
  });

  it('keeps a template ID above 2^53 exact', () => {
    const { handler } = setup();
    const raw = JSON.stringify(fixture('status-approved')).replace(
      '900000000000001',
      '9007199254740993123',
    );

    const [event] = handler.extract(Buffer.from(raw));

    expect(event.providerTemplateId).toBe('9007199254740993123');
  });

  it('reads - and _ in the language code alike', () => {
    const { handler } = setup();
    const raw = JSON.stringify(fixture('quality-red')).replace(
      '"message_template_language":"ar"',
      '"message_template_language":"en-US"',
    );

    expect(handler.extract(Buffer.from(raw))).toEqual([
      expect.objectContaining({ languageCode: 'en_US' }),
    ]);
  });

  it('drops a change from another WhatsApp Business Account', () => {
    const { handler } = setup({ WA_BUSINESS_ACCOUNT_ID: '999' });

    expect(handler.extract(body(fixture('status-paused')))).toEqual([]);
    expect(warn.mock.calls.join('\n')).toContain('wrong_account');
  });

  it('ignores message fields and leaves them to the message handler', () => {
    const { handler } = setup();
    const messages = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 1767268800,
          changes: [
            {
              field: 'messages',
              value: { messages: [{ id: 'wamid.1', type: 'button' }] },
            },
          ],
        },
      ],
    };

    expect(handler.extract(body(messages))).toEqual([]);
  });

  it('reads nothing while template sync is switched off', async () => {
    const { handler, templateStatus } = setup({
      WHATSAPP_TEMPLATE_SYNC_ENABLED: 'false',
    });

    await handler.handle(body(fixture('status-paused')));

    expect(templateStatus.applyEvents).not.toHaveBeenCalled();
  });

  it('hands every template change of a batched delivery over at once', async () => {
    const { handler, templateStatus } = setup();
    const paused = fixture('status-paused') as { entry: unknown[] };
    const red = fixture('quality-red') as { entry: unknown[] };

    await handler.handle(
      body({ ...paused, entry: [...paused.entry, ...red.entry] }),
    );

    expect(templateStatus.applyEvents).toHaveBeenCalledWith([
      expect.objectContaining({ field: 'status', status: 'paused' }),
      expect.objectContaining({ field: 'quality', quality: 'low' }),
    ]);
  });

  it('never throws, whatever the body or the registry does', async () => {
    const { handler, templateStatus } = setup();
    templateStatus.applyEvents.mockRejectedValue(new Error('db down'));

    await expect(
      handler.handle(body(fixture('status-paused'))),
    ).resolves.toBeUndefined();
    await expect(
      handler.handle(Buffer.from('not json')),
    ).resolves.toBeUndefined();
    await expect(handler.handle(undefined)).resolves.toBeUndefined();
  });
});
