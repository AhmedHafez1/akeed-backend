import { Logger } from '@nestjs/common';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  FakeMetaTemplateApi,
  akeedTemplates,
  codComponents,
} from '../../../test/contracts/meta-template-api-fake';
import { MetaTemplateCatalogAdapter } from '../../infrastructure/spokes/meta/meta-template-catalog.adapter';
import { parseWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import { TemplateAlertService } from './template-alert.service';
import { InMemoryTemplateSyncRepository } from './testing/in-memory-template-sync.repository';
import {
  MANUAL_SYNC_COOLDOWN_MS,
  WhatsappTemplateSyncService,
} from './whatsapp-template-sync.service';

function setup(
  options: { api?: FakeMetaTemplateApi; syncEnabled?: boolean } = {},
) {
  const api = options.api ?? new FakeMetaTemplateApi();
  const values: Record<string, unknown> = {
    WA_ACCESS_TOKEN: FAKE_TOKEN,
    whatsappTemplates: parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_SYNC_ENABLED: String(options.syncEnabled ?? true),
      WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
    }),
  };
  const config = { get: (key: string) => values[key] };
  const repository = new InMemoryTemplateSyncRepository();
  const registry = {
    listTemplates: jest.fn(),
    invalidate: jest.fn(),
  };
  const adapter = new MetaTemplateCatalogAdapter(
    api.httpService as never,
    config as never,
  );
  const service = new WhatsappTemplateSyncService(
    repository as never,
    adapter,
    registry,
    new TemplateAlertService(repository as never),
    config as never,
  );
  return { service, repository, registry, api };
}

describe('WhatsappTemplateSyncService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  function alerts(): Record<string, unknown>[] {
    return warn.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((entry) => entry.action === 'whatsapp-template-alert');
  }

  it('fills status, category, quality, snapshot and ID on every matching row', async () => {
    const { service, repository, registry } = setup();

    const result = await service.runSync('scheduled');

    expect(result).toMatchObject({
      outcome: 'succeeded',
      run: {
        status: 'succeeded',
        providerTemplateCount: 8,
        updatedCount: 8,
        unchangedCount: 0,
        missingKeys: [],
        unknownAtProvider: [],
      },
    });
    expect(repository.row('cod_confirm.ar.egyptian')).toMatchObject({
      providerTemplateId: '900000000000002',
      reviewStatus: 'approved',
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
    expect(repository.lastSyncedAt.size).toBe(8);
    expect(registry.invalidate).toHaveBeenCalled();
  });

  it('is idempotent: a second run with the same provider data changes nothing', async () => {
    const { service, repository } = setup();
    await service.runSync('scheduled');
    const providerSide = () =>
      JSON.stringify(
        repository.rows.map((row) => ({
          ...row,
          statusEventAt: undefined,
          qualityEventAt: undefined,
          categoryEventAt: undefined,
        })),
      );
    const before = providerSide();

    const result = await service.runSync('scheduled');

    expect(result).toMatchObject({
      outcome: 'succeeded',
      run: { updatedCount: 0, unchangedCount: 8 },
    });
    expect(providerSide()).toBe(before);
    expect(repository.driftAt.size).toBe(0);
  });

  it('reports a provider template with no registry row, without creating one', async () => {
    const api = new FakeMetaTemplateApi({
      templates: [
        ...akeedTemplates(),
        {
          id: '930000000000001',
          name: 'akeed_marketing_promo',
          language: 'en_US',
          status: 'APPROVED',
          category: 'MARKETING',
          quality_score: 'GREEN',
          components: codComponents('Promo'),
        },
      ],
    });
    const { service, repository } = setup({ api });

    const result = await service.runSync('scheduled');

    expect(result).toMatchObject({
      run: {
        unknownAtProvider: [
          { templateName: 'akeed_marketing_promo', languageCode: 'en_US' },
        ],
      },
    });
    expect(repository.rows).toHaveLength(8);
  });

  it('marks a registry row with no provider template as missing, and alerts when it is in use', async () => {
    const api = new FakeMetaTemplateApi({
      templates: akeedTemplates().filter(
        (template) => template.name !== 'akeed_cod_verification_direct_eg',
      ),
    });
    const { service, repository } = setup({ api });
    repository.storeCounts.set('cod_confirm.ar.egyptian', 3);

    const result = await service.runSync('scheduled');

    expect(result).toMatchObject({
      run: { missingKeys: ['cod_confirm.ar.egyptian'] },
    });
    expect(repository.row('cod_confirm.ar.egyptian').reviewStatus).toBe(
      'missing',
    );
    expect(alerts()).toEqual([
      expect.objectContaining({
        alertCode: 'template_unavailable',
        severity: 'critical',
        templateKey: 'cod_confirm.ar.egyptian',
        reviewStatus: 'missing',
        affectedStoreCount: 3,
      }),
    ]);
  });

  it('flags drift when the provider text differs from the previous snapshot', async () => {
    const api = new FakeMetaTemplateApi();
    const { service, repository } = setup({ api });
    await service.runSync('scheduled');
    api.templates[0] = {
      ...api.templates[0],
      components: codComponents('Edited synthetic body {{1}}'),
    };

    await service.runSync('scheduled');

    expect([...repository.driftAt.keys()]).toEqual(['cod_confirm.ar.standard']);
    expect(alerts()).toEqual([
      expect.objectContaining({
        alertCode: 'template_text_changed',
        severity: 'attention',
        templateKey: 'cod_confirm.ar.standard',
      }),
    ]);
  });

  it('does not call an unreadable response drift', async () => {
    const api = new FakeMetaTemplateApi();
    const { service, repository } = setup({ api });
    await service.runSync('scheduled');
    api.templates[0] = { ...api.templates[0], components: { odd: true } };

    await service.runSync('scheduled');

    expect(repository.driftAt.size).toBe(0);
    expect(repository.row('cod_confirm.ar.standard').components).toEqual({
      unknown: true,
    });
  });

  it('alerts on a re-categorization of a template in use, and keeps it approved', async () => {
    const api = new FakeMetaTemplateApi();
    const { service, repository } = setup({ api });
    await service.runSync('scheduled');
    api.templates[4] = { ...api.templates[4], category: 'MARKETING' };

    await service.runSync('scheduled');

    expect(repository.row('cod_confirm.en.friendly')).toMatchObject({
      reviewStatus: 'approved',
      category: 'marketing',
    });
    expect(alerts()).toEqual([
      expect.objectContaining({
        alertCode: 'template_recategorized',
        severity: 'critical',
        templateKey: 'cod_confirm.en.friendly',
        isDefault: true,
      }),
    ]);
  });

  it('does not alert for a template no store sends and that is not a default', async () => {
    const api = new FakeMetaTemplateApi();
    api.templates[2] = { ...api.templates[2], status: 'PAUSED' };
    const { service, repository } = setup({ api });

    await service.runSync('scheduled');

    expect(repository.row('cod_confirm.ar.gulf').reviewStatus).toBe('paused');
    expect(alerts()).toEqual([]);
  });

  describe('during a Meta outage', () => {
    it.each([
      [
        'a 503 page',
        { kind: 'server_error', httpStatus: 503 } as const,
        'provider_error',
      ],
      ['a dropped connection', { kind: 'network' } as const, 'network'],
      [
        'a rate limit',
        { kind: 'meta_error', httpStatus: 400, code: 80007 } as const,
        'rate_limited',
      ],
      [
        'an expired token',
        { kind: 'meta_error', httpStatus: 401, code: 190 } as const,
        'auth_failed',
      ],
    ])(
      'changes no row on %s, records the failed run and alerts',
      async (_label, failure, code) => {
        const api = new FakeMetaTemplateApi();
        const { service, repository, registry } = setup({ api });
        await service.runSync('scheduled');
        const before = JSON.stringify(repository.rows);
        api.failOnPage(2, failure);

        const result = await service.runSync('scheduled');

        expect(result).toMatchObject({
          outcome: 'failed',
          run: { status: 'failed', errorCode: code },
        });
        expect(JSON.stringify(repository.rows)).toBe(before);
        expect(registry.invalidate).toHaveBeenCalledTimes(1);
        expect(alerts()).toEqual([
          expect.objectContaining({
            alertCode: 'template_sync_failed',
            errorCode: code,
            trigger: 'scheduled',
          }),
        ]);
        expect(warn.mock.calls.join('\n')).not.toContain(FAKE_TOKEN);
      },
    );

    it('changes no row when a rate limit arrives mid-pagination, and makes no further request', async () => {
      const api = new FakeMetaTemplateApi({ pageSize: 3 }).failOnPage(2, {
        kind: 'meta_error',
        httpStatus: 400,
        code: 4,
      });
      const { service, repository } = setup({ api });
      const before = JSON.stringify(repository.rows);

      const result = await service.runSync('scheduled');

      expect(result).toMatchObject({ run: { errorCode: 'rate_limited' } });
      expect(api.requests).toHaveLength(2);
      expect(JSON.stringify(repository.rows)).toBe(before);
    });

    it('records a failed run when the registry write itself fails', async () => {
      const { service, repository } = setup();
      repository.failNextCompleteSync = true;

      const result = await service.runSync('scheduled');

      expect(result).toMatchObject({
        outcome: 'failed',
        run: { errorCode: 'persistence_failed' },
      });
      expect(repository.rows.every((row) => row.reviewStatus === null)).toBe(
        true,
      );
    });
  });

  it('does nothing while sync is switched off', async () => {
    const { service, api, repository } = setup({ syncEnabled: false });

    await expect(service.runSync('manual', 'staff-1')).resolves.toEqual({
      outcome: 'disabled',
    });
    expect(api.requests).toHaveLength(0);
    expect(repository.runs).toHaveLength(0);
  });

  it('runs one sync at a time', async () => {
    const { service, repository } = setup();
    await repository.startRun('scheduled', null);

    await expect(service.runSync('scheduled')).resolves.toEqual({
      outcome: 'in_progress',
    });
  });

  it('refuses a manual sync within the cooldown, but not a scheduled one', async () => {
    const { service } = setup();
    await service.runSync('scheduled');

    const manual = await service.runSync('manual', 'staff-1');
    expect(manual).toMatchObject({ outcome: 'cooldown' });
    expect(
      (manual as { retryAfterSeconds: number }).retryAfterSeconds,
    ).toBeLessThanOrEqual(MANUAL_SYNC_COOLDOWN_MS / 1000);
    await expect(service.runSync('scheduled')).resolves.toMatchObject({
      outcome: 'succeeded',
    });
  });
});
