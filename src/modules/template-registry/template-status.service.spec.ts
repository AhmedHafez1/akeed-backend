import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { MetaTemplateWebhookHandler } from '../../infrastructure/spokes/meta/meta-template-webhook.handler';
import { parseWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import { TemplateAlertService } from './template-alert.service';
import { TemplateStatusService } from './template-status.service';
import { InMemoryTemplateSyncRepository } from './testing/in-memory-template-sync.repository';

const FIXTURES = resolve(
  __dirname,
  '../../../test/fixtures/whatsapp-templates/webhooks',
);
const ACCOUNT_ID = '100000000000001';
const ARABIC_DEFAULT = 'cod_confirm.ar.standard';

type Payload = {
  entry: {
    id: string;
    time: number;
    changes: { field: string; value: Record<string, unknown> }[];
  }[];
};

function fixture(name: string): Payload {
  return (
    JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as {
      payload: Payload;
    }
  ).payload;
}

function at(payload: Payload, time: number): Payload {
  return { ...payload, entry: [{ ...payload.entry[0], time }] };
}

/**
 * US-08-04 criterion 3, from the committed webhook fixtures through the real
 * handler and the real event rules. The fixtures name the Arabic default
 * (`akeed_cod_verification_friendly` / `ar`).
 */
function setup() {
  const config = parseWhatsappTemplateConfig({
    WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
    WA_BUSINESS_ACCOUNT_ID: ACCOUNT_ID,
  });
  const repository = new InMemoryTemplateSyncRepository();
  const registry = { listTemplates: jest.fn(), invalidate: jest.fn() };
  const producer = { requestSyncSoon: jest.fn().mockResolvedValue(undefined) };
  const status = new TemplateStatusService(
    repository as never,
    registry,
    new TemplateAlertService(repository as never),
    producer as never,
  );
  const handler = new MetaTemplateWebhookHandler(
    { get: () => config } as never,
    status,
  );
  const deliver = (payload: Payload) =>
    handler.handle(Buffer.from(JSON.stringify(payload)));
  return { repository, registry, producer, deliver, status };
}

describe('TemplateStatusService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  function alerts(): Record<string, unknown>[] {
    return warn.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((entry) => entry.action === 'whatsapp-template-alert');
  }

  it('applies a status event, invalidates the registry copy and asks for a sync', async () => {
    const { repository, registry, producer, deliver } = setup();

    await deliver(fixture('status-paused'));

    expect(repository.row(ARABIC_DEFAULT)).toMatchObject({
      reviewStatus: 'paused',
      statusEventAt: new Date(1767268980 * 1000).toISOString(),
    });
    expect(registry.invalidate).toHaveBeenCalled();
    expect(producer.requestSyncSoon).toHaveBeenCalledTimes(1);
  });

  it('applies quality and category events to their own fields', async () => {
    const { repository, deliver } = setup();

    await deliver(fixture('quality-red'));
    await deliver(fixture('category-impending'));

    expect(repository.row(ARABIC_DEFAULT)).toMatchObject({
      quality: 'low',
      category: 'utility',
      pendingCategory: 'marketing',
      reviewStatus: null,
    });
  });

  it('treats a duplicate delivery as a no-op', async () => {
    const { repository, producer, deliver } = setup();
    await deliver(fixture('status-paused'));
    await deliver(at(fixture('status-approved'), 1767268990));
    expect(repository.row(ARABIC_DEFAULT).reviewStatus).toBe('approved');

    await deliver(fixture('status-paused'));

    expect(repository.row(ARABIC_DEFAULT).reviewStatus).toBe('approved');
    expect(repository.events).toHaveLength(2);
    expect(producer.requestSyncSoon).toHaveBeenCalledTimes(2);
  });

  it('ignores an older event that arrives after a newer one, and stores it as stale', async () => {
    const { repository, deliver } = setup();

    await deliver(fixture('status-disabled'));
    await deliver(fixture('status-approved'));

    expect(repository.row(ARABIC_DEFAULT).reviewStatus).toBe('disabled');
    expect(repository.events.map((event) => event.outcome)).toEqual([
      'applied',
      'stale',
    ]);
  });

  it('orders each field on its own', async () => {
    const { repository, deliver } = setup();

    await deliver(at(fixture('status-paused'), 1767300000));
    await deliver(at(fixture('quality-red'), 1767200000));

    expect(repository.row(ARABIC_DEFAULT)).toMatchObject({
      reviewStatus: 'paused',
      quality: 'low',
    });
  });

  it('does not order two different events of the same second: a conflict asks for a sync', async () => {
    const { repository, producer, deliver } = setup();

    await deliver(at(fixture('status-paused'), 1767300000));
    await deliver(at(fixture('status-approved'), 1767300000));

    expect(repository.row(ARABIC_DEFAULT).reviewStatus).toBe('paused');
    expect(repository.events.map((event) => event.outcome)).toEqual([
      'applied',
      'conflict',
    ]);
    expect(producer.requestSyncSoon).toHaveBeenCalledTimes(2);
  });

  it('does not let a webhook older than the last sync overwrite it', async () => {
    const { repository, deliver } = setup();
    Object.assign(repository.row(ARABIC_DEFAULT), {
      reviewStatus: 'approved',
      statusEventAt: '2026-06-01T00:00:00.000Z',
    });

    await deliver(fixture('status-paused'));

    expect(repository.row(ARABIC_DEFAULT).reviewStatus).toBe('approved');
  });

  it('reports a template with no registry row and creates none', async () => {
    const { repository, deliver } = setup();
    const payload = fixture('status-paused');
    payload.entry[0].changes[0].value.message_template_name = 'not_in_akeed';

    await deliver(payload);

    expect(repository.rows).toHaveLength(8);
    expect(repository.events).toEqual([
      expect.objectContaining({ outcome: 'unregistered', templateId: null }),
    ]);
    expect(warn.mock.calls.join('\n')).toContain('unregistered');
  });

  it('alerts when a language default becomes unavailable, without template text', async () => {
    const { deliver } = setup();

    await deliver(fixture('status-rejected'));

    expect(alerts()).toEqual([
      {
        app: 'backend',
        env: 'test',
        module: 'TemplateAlertService',
        action: 'whatsapp-template-alert',
        outcome: 'failure',
        alertCode: 'template_unavailable',
        severity: 'critical',
        templateKey: ARABIC_DEFAULT,
        reviewStatus: 'rejected',
        category: null,
        pendingCategory: null,
        isDefault: true,
        affectedStoreCount: 0,
      },
    ]);
    expect(warn.mock.calls.join('\n')).not.toContain('Synthetic');
  });

  it('alerts on a scheduled re-categorization of a template in use', async () => {
    const { deliver } = setup();

    await deliver(fixture('category-impending'));

    expect(alerts()).toEqual([
      expect.objectContaining({
        alertCode: 'template_recategorized',
        templateKey: ARABIC_DEFAULT,
        pendingCategory: 'marketing',
      }),
    ]);
  });

  it('alerts once on the transition, not again while the template stays unavailable', async () => {
    const { deliver } = setup();

    await deliver(fixture('status-paused'));
    await deliver(fixture('status-disabled'));

    expect(alerts()).toHaveLength(1);
  });
});
