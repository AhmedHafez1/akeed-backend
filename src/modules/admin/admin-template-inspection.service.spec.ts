import { randomUUID } from 'node:crypto';
import type { InspectedTemplate } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import type { TemplateSyncRun } from '../../infrastructure/database/repositories/whatsapp-template-sync.repository';
import {
  MESSAGE_IMPROVEMENT_SWITCHES_OFF,
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import type { TemplateComponentsSnapshot } from '../../shared/messaging/template-provider.types';
import {
  seededRegistryTemplates,
  syncedApprovedTemplates,
} from '../../shared/messaging/testing/seeded-template-registry';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import type { TemplateTextModel } from '../../shared/messaging/template-text.types';
import { TemplateMessageService } from '../template-registry/template-message.service';
import type {
  AdminTemplateMetricsRow,
  AdminTemplatePurposeMetricsRow,
} from './admin-query.repository';
import { AdminTemplateInspectionService } from './admin-template-inspection.service';

const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';
const STAFF = '0f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';
const RANGE = { from: '2026-09-06', to: '2026-10-05' };

/** A snapshot whose text is exactly what the short English preview shows. */
const SHORT_EN_SNAPSHOT: TemplateComponentsSnapshot = {
  body: 'stored as the provider wrote it',
  buttons: [
    { kind: 'quick_reply', text: 'Confirm' },
    { kind: 'quick_reply', text: 'Cancel' },
  ],
};
const SHORT_EN_MODEL: TemplateTextModel = {
  format: 'positional',
  body: [
    { text: 'Hello\n\nWe have received your order #' },
    { parameter: '1' },
    { text: ' with Cash on Delivery.\nTotal Price: ' },
    { parameter: '2' },
    { text: '\n\nPlease confirm your order.' },
  ],
  buttons: SHORT_EN_SNAPSHOT.buttons,
};

function inspected(
  template: RegistryTemplate,
  overrides: Partial<InspectedTemplate> = {},
): InspectedTemplate {
  return {
    id: randomUUID(),
    template,
    quality: template.lastSyncedAt ? 'pending' : null,
    pendingCategory: null,
    providerTemplateId: template.lastSyncedAt ? '900000000000001' : null,
    components: null,
    componentsDriftAt: null,
    ...overrides,
  };
}

function metricsRow(
  variantKey: string | null,
  counts: Partial<AdminTemplateMetricsRow> = {},
): AdminTemplateMetricsRow {
  return {
    variant_key: variantKey,
    template_name: 'name',
    language_code: 'en',
    language: 'en',
    sends: 0,
    sends_initial: 0,
    sends_reminder: 0,
    sends_test: 0,
    delivered: 0,
    read: 0,
    confirmed: 0,
    canceled: 0,
    no_reply: 0,
    ...counts,
  };
}

function run(overrides: Partial<TemplateSyncRun> = {}): TemplateSyncRun {
  return {
    id: randomUUID(),
    trigger: 'scheduled',
    requestedBy: null,
    status: 'succeeded',
    startedAt: '2026-10-05T10:00:00.000Z',
    finishedAt: '2026-10-05T10:00:02.000Z',
    providerTemplateCount: 9,
    updatedCount: 0,
    unchangedCount: 8,
    missingKeys: [],
    unknownAtProvider: [],
    errorCode: null,
    ...overrides,
  };
}

function setup(
  options: {
    rows?: InspectedTemplate[];
    metrics?: AdminTemplateMetricsRow[];
    byPurpose?: AdminTemplatePurposeMetricsRow[];
    runs?: TemplateSyncRun[];
    storeCounts?: Map<string, number>;
    env?: Record<string, string>;
    snapshotPreview?: boolean;
  } = {},
) {
  const rows =
    options.rows ??
    syncedApprovedTemplates().map((template) => inspected(template));
  const templates = {
    findAllForInspection: jest.fn().mockResolvedValue(rows),
    findForInspection: jest.fn((key: string) =>
      Promise.resolve(rows.find((row) => row.template.key === key)),
    ),
  };
  const syncRepository = {
    activeStoreCountsByKey: jest
      .fn()
      .mockResolvedValue(options.storeCounts ?? new Map<string, number>()),
    activeStoresUsingKey: jest.fn().mockResolvedValue({ total: 0, stores: [] }),
    eventsForTemplate: jest.fn().mockResolvedValue([]),
  };
  const metrics = {
    findTemplateMetrics: jest.fn().mockResolvedValue(options.metrics ?? []),
    findTemplateMetricsByPurpose: jest
      .fn()
      .mockResolvedValue(options.byPurpose ?? []),
  };
  const sync = {
    recentRuns: jest.fn((limit: number) =>
      Promise.resolve((options.runs ?? []).slice(0, limit)),
    ),
  };
  const catalog = {
    listTemplates: jest.fn(),
    createTemplate: jest.fn(),
    editTemplate: jest.fn(),
    // Stands in for the provider adapter: only one snapshot is readable.
    describeComponents: jest.fn(
      (snapshot: TemplateComponentsSnapshot | null) =>
        snapshot === SHORT_EN_SNAPSHOT ? SHORT_EN_MODEL : null,
    ),
  };
  const values: Record<string, unknown> = {
    [WHATSAPP_TEMPLATE_CONFIG]: parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
      WHATSAPP_TEMPLATE_OPERATOR_IDS: OPERATOR,
      WHATSAPP_TEMPLATE_TEST_PHONES: '+201001234567',
      ...options.env,
    }),
  };
  const service = new AdminTemplateInspectionService(
    templates as never,
    syncRepository as never,
    metrics as never,
    sync as never,
    catalog,
    { get: (key: string) => values[key] } as never,
    new TemplateMessageService(catalog, {
      current: () => ({
        ...MESSAGE_IMPROVEMENT_SWITCHES_OFF,
        snapshotPreview: options.snapshotPreview ?? false,
      }),
    } as never),
  );
  return { service, templates, syncRepository, metrics, sync, catalog, rows };
}

describe('AdminTemplateInspectionService', () => {
  describe('list', () => {
    it('lists every registry template with what the provider says about it', async () => {
      const { service } = setup({
        storeCounts: new Map([['cod_confirm.ar.standard', 12]]),
      });

      const response = await service.list(STAFF, RANGE);

      expect(response.templates.map((template) => template.key)).toEqual(
        seededRegistryTemplates().map((template) => template.key),
      );
      expect(response.templates[0]).toEqual({
        key: 'cod_confirm.ar.standard',
        purpose: 'cod_confirmation',
        language: 'ar',
        style: 'standard',
        template_name: 'akeed_cod_verification_friendly',
        language_code: 'ar',
        parameter_format: 'named',
        review_status: 'approved',
        category: 'utility',
        pending_category: null,
        quality: 'pending',
        is_active: true,
        is_default: true,
        sendable: true,
        last_synced_at: '2026-10-05T00:00:00.000Z',
        active_store_count: 12,
        drift: { state: 'unreadable', kinds: [], severity: null },
        metrics: {
          sends: 0,
          delivered: 0,
          read: 0,
          replies: 0,
          confirmed: 0,
          canceled: 0,
          no_reply: 0,
          reply_rate: null,
          confirmation_rate: null,
        },
      });
      expect(response.range).toEqual({ ...RANGE, timezone: 'UTC' });
    });

    it('takes each template metrics from the repository query, by variant key', async () => {
      const rows = [
        metricsRow('ar.egyptian', {
          sends: 40,
          sends_initial: 30,
          sends_reminder: 10,
          delivered: 38,
          read: 31,
          confirmed: 21,
          canceled: 4,
          no_reply: 6,
        }),
        // The driver may hand counts back as strings.
        metricsRow('en.short', { sends: '3', confirmed: '1', canceled: '0' }),
        // Sends accepted before identity was recorded belong to no template.
        metricsRow(null, { sends: 500, confirmed: 400 }),
      ];
      const { service, metrics } = setup({ metrics: rows });

      const response = await service.list(STAFF, RANGE);
      const byKey = new Map(
        response.templates.map((template) => [template.key, template.metrics]),
      );

      expect(metrics.findTemplateMetrics).toHaveBeenCalledWith({
        from: '2026-09-06T00:00:00.000Z',
        toExclusive: '2026-10-06T00:00:00.000Z',
        includeTest: false,
      });
      expect(byKey.get('cod_confirm.ar.egyptian')).toEqual({
        sends: 40,
        delivered: 38,
        read: 31,
        replies: 25,
        confirmed: 21,
        canceled: 4,
        no_reply: 6,
        reply_rate: 0.625,
        confirmation_rate: 0.525,
      });
      expect(byKey.get('cod_confirm.en.short')).toMatchObject({
        sends: 3,
        confirmed: 1,
        replies: 1,
        confirmation_rate: 0.3333,
      });
      const total = [...byKey.values()].reduce(
        (sum, entry) => sum + entry.sends,
        0,
      );
      expect(total).toBe(43);
    });

    it('refuses a range the metrics query would refuse', async () => {
      const { service, metrics } = setup();

      await expect(
        service.list(STAFF, { from: '2026-10-05', to: '2026-10-01' }),
      ).rejects.toMatchObject({
        response: { code: 'ADMIN_TEMPLATE_METRICS_RANGE_INVALID' },
      });
      expect(metrics.findTemplateMetrics).not.toHaveBeenCalled();
    });

    it('shows a never-synced environment as sendable while active, with nothing to compare', async () => {
      const { service } = setup({
        rows: seededRegistryTemplates().map((template) => inspected(template)),
      });

      const response = await service.list(STAFF, RANGE);

      expect(
        response.templates.every(
          (template) =>
            template.sendable &&
            template.review_status === null &&
            template.drift.state === 'not_synced',
        ),
      ).toBe(true);
      expect(response.sync.last_run).toBeNull();
    });

    it('marks a template the provider paused or lacks as not sendable', async () => {
      const rows = syncedApprovedTemplates().map((template) =>
        inspected(
          template.key === 'cod_confirm.en.direct'
            ? { ...template, reviewStatus: 'missing' }
            : template.key === 'cod_confirm.ar.gulf'
              ? { ...template, reviewStatus: 'paused' }
              : template,
        ),
      );
      const { service } = setup({ rows });

      const response = await service.list(STAFF, RANGE);
      const find = (key: string) =>
        response.templates.find((template) => template.key === key);

      expect(find('cod_confirm.en.direct')).toMatchObject({
        sendable: false,
        review_status: 'missing',
        drift: { state: 'missing' },
      });
      expect(find('cod_confirm.ar.gulf')).toMatchObject({ sendable: false });
      expect(find('cod_confirm.ar.standard')).toMatchObject({ sendable: true });
    });

    it('tells an operator from other staff, and whether a test can be sent', async () => {
      const operator = await setup().service.list(OPERATOR, RANGE);
      const staff = await setup().service.list(STAFF, RANGE);
      const noPhones = await setup({
        env: { WHATSAPP_TEMPLATE_TEST_PHONES: '' },
      }).service.list(OPERATOR, RANGE);

      expect(operator.operations).toEqual({
        enabled: true,
        operator: true,
        test_send_available: true,
      });
      expect(staff.operations).toEqual({
        enabled: true,
        operator: false,
        test_send_available: false,
      });
      expect(noPhones.operations.test_send_available).toBe(false);
    });

    it('returns no phone, token or account ID', async () => {
      const { service } = setup({
        runs: [run()],
        env: {
          WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
          WA_BUSINESS_ACCOUNT_ID: '100000000000001',
        },
      });

      const body = JSON.stringify(await service.list(OPERATOR, RANGE));

      expect(body).not.toContain('201001234567');
      expect(body).not.toContain('100000000000001');
      expect(body).not.toContain(OPERATOR);
      expect(body).not.toMatch(/token|secret/i);
    });
  });

  describe('detail', () => {
    function shortEnglish() {
      return syncedApprovedTemplates().map((template) =>
        inspected(
          template,
          template.key === 'cod_confirm.en.short'
            ? { components: SHORT_EN_SNAPSHOT }
            : {},
        ),
      );
    }

    it('renders the provider text with sample values, and the variable mapping', async () => {
      const { service, catalog } = setup({ rows: shortEnglish() });

      const response = await service.detail(
        STAFF,
        'cod_confirm.en.short',
        RANGE,
      );

      expect(catalog.describeComponents).toHaveBeenCalledWith(
        SHORT_EN_SNAPSHOT,
      );
      expect(response.message).toEqual({
        paragraphs: [
          'Hello',
          'We have received your order #TEST-1 with Cash on Delivery.',
          'Total Price: 250.00 USD',
          'Please confirm your order.',
        ],
        buttons: [
          { label: 'Confirm', kind: 'quick_reply' },
          { label: 'Cancel', kind: 'quick_reply' },
        ],
        direction: 'ltr',
      });
      expect(response.registered_preview.paragraphs).toEqual(
        response.message?.paragraphs,
      );
      expect(response.variables).toEqual([
        { variable: 'order', parameter: '1', sample: 'TEST-1' },
        { variable: 'total', parameter: '2', sample: '250.00 USD' },
      ]);
      expect(response.drift).toEqual({
        state: 'in_sync',
        kinds: [],
        severity: null,
        differences: [],
      });
    });

    it('names the parameters of a named template, right to left for Arabic', async () => {
      const { service } = setup();

      const response = await service.detail(
        STAFF,
        'cod_confirm.ar.egyptian',
        RANGE,
      );

      expect(response.variables).toEqual([
        { variable: 'customer', parameter: 'customer', sample: 'أحمد' },
        { variable: 'order', parameter: 'order', sample: 'TEST-1' },
        { variable: 'store', parameter: 'store', sample: 'متجر أكيد' },
        { variable: 'total', parameter: 'total', sample: '250.00 USD' },
      ]);
      expect(response.registered_preview.direction).toBe('rtl');
      // Its snapshot is not readable here, so there is no text to show.
      expect(response.message).toBeNull();
      expect(response.drift.state).toBe('unreadable');
    });

    it('lists what differs when the provider text has drifted', async () => {
      const rows = syncedApprovedTemplates().map((template) =>
        inspected(
          template.key === 'cod_confirm.en.short'
            ? {
                ...template,
                preview: { ...template.preview, confirmButton: 'Yes' },
              }
            : template,
          template.key === 'cod_confirm.en.short'
            ? {
                components: SHORT_EN_SNAPSHOT,
                componentsDriftAt: '2026-10-04T08:00:00.000Z',
              }
            : {},
        ),
      );
      const { service } = setup({ rows });

      const response = await service.detail(
        STAFF,
        'cod_confirm.en.short',
        RANGE,
      );

      expect(response.drift).toEqual({
        state: 'drift',
        kinds: ['button_labels'],
        severity: 'preview',
        differences: [
          {
            kind: 'button_labels',
            severity: 'preview',
            registered: 'Yes | Cancel',
            provider: 'Confirm | Cancel',
          },
        ],
      });
      expect(response.template.text_changed_at).toBe(
        '2026-10-04T08:00:00.000Z',
      );
    });

    it('compares only what is sent once merchants preview the provider text', async () => {
      const rows = syncedApprovedTemplates().map((template) =>
        template.key === 'cod_confirm.en.short'
          ? inspected(
              {
                ...template,
                preview: { ...template.preview, confirmButton: 'Yes' },
                components: SHORT_EN_SNAPSHOT,
              },
              { components: SHORT_EN_SNAPSHOT },
            )
          : inspected(template),
      );
      const stored = await setup({ rows }).service.list(STAFF, RANGE);
      const { service } = setup({ rows, snapshotPreview: true });

      const shown = await service.list(STAFF, RANGE);
      const detail = await service.detail(STAFF, 'cod_confirm.en.short', RANGE);
      const driftOfShort = (response: typeof shown) =>
        response.templates.find(
          (template) => template.key === 'cod_confirm.en.short',
        )?.drift;

      expect(driftOfShort(stored)).toMatchObject({
        state: 'drift',
        severity: 'preview',
      });
      expect(driftOfShort(shown)).toEqual({
        state: 'in_sync',
        kinds: [],
        severity: null,
      });
      expect(detail.drift).toEqual({
        state: 'in_sync',
        kinds: [],
        severity: null,
        differences: [],
      });
    });

    it('returns per-purpose metrics, history and the stores that send it', async () => {
      const missingRun = run({ missingKeys: ['cod_confirm.en.short'] });
      const failedRun = run({ status: 'failed', errorCode: 'rate_limited' });
      const { service, metrics, syncRepository, rows } = setup({
        rows: shortEnglish(),
        runs: [missingRun, failedRun],
        byPurpose: [
          {
            purpose: 'initial',
            sends: 10,
            sends_initial: 10,
            sends_reminder: 0,
            sends_test: 0,
            delivered: 9,
            read: 8,
            confirmed: 5,
            canceled: 1,
            no_reply: 2,
          },
          {
            purpose: 'reminder',
            sends: 4,
            sends_initial: 0,
            sends_reminder: 4,
            sends_test: 0,
            delivered: 4,
            read: 2,
            confirmed: 1,
            canceled: 0,
            no_reply: 3,
          },
        ],
      });
      const row = rows.find(
        (entry) => entry.template.key === 'cod_confirm.en.short',
      );
      syncRepository.eventsForTemplate.mockResolvedValue([
        {
          id: 'event-1',
          field: 'status',
          neutralValue: { status: 'paused' },
          outcome: 'applied',
          occurredAt: '2026-10-05T09:00:00.000Z',
          receivedAt: '2026-10-05T09:00:01.000Z',
        },
      ]);
      syncRepository.activeStoresUsingKey.mockResolvedValue({
        total: 2,
        stores: [
          {
            integrationId: 'integration-1',
            storeName: 'Akeed Fashion',
            platformType: 'shopify',
            storeUrl: 'akeed-fashion.myshopify.com',
            defaultLanguage: 'auto',
          },
          {
            integrationId: 'integration-2',
            storeName: 'Cairo Books',
            platformType: 'standalone',
            storeUrl: 'standalone:internal-identity',
            defaultLanguage: 'en',
          },
        ],
      });

      const response = await service.detail(
        STAFF,
        'cod_confirm.en.short',
        RANGE,
      );

      expect(metrics.findTemplateMetricsByPurpose).toHaveBeenCalledWith(
        {
          from: '2026-09-06T00:00:00.000Z',
          toExclusive: '2026-10-06T00:00:00.000Z',
          includeTest: false,
        },
        'en.short',
      );
      expect(response.metrics_by_purpose).toEqual([
        {
          purpose: 'initial',
          sends: 10,
          delivered: 9,
          read: 8,
          replies: 6,
          confirmed: 5,
          canceled: 1,
          no_reply: 2,
          reply_rate: 0.6,
          confirmation_rate: 0.5,
        },
        {
          purpose: 'reminder',
          sends: 4,
          delivered: 4,
          read: 2,
          replies: 1,
          confirmed: 1,
          canceled: 0,
          no_reply: 3,
          reply_rate: 0.25,
          confirmation_rate: 0.25,
        },
      ]);
      expect(syncRepository.eventsForTemplate).toHaveBeenCalledWith(
        row?.id,
        50,
      );
      expect(response.history.events).toEqual([
        {
          id: 'event-1',
          field: 'status',
          value: { status: 'paused' },
          outcome: 'applied',
          occurred_at: '2026-10-05T09:00:00.000Z',
          received_at: '2026-10-05T09:00:01.000Z',
        },
      ]);
      expect(response.history.sync_runs).toEqual([
        expect.objectContaining({ id: missingRun.id, missing: true }),
        expect.objectContaining({
          id: failedRun.id,
          missing: false,
          status: 'failed',
          error_code: 'rate_limited',
        }),
      ]);
      expect(response.stores).toEqual({
        total: 2,
        shown: [
          {
            integration_id: 'integration-1',
            store_name: 'Akeed Fashion',
            platform: 'shopify',
            domain: 'akeed-fashion.myshopify.com',
            default_language: 'auto',
          },
          {
            integration_id: 'integration-2',
            store_name: 'Cairo Books',
            platform: 'standalone',
            domain: null,
            default_language: 'en',
          },
        ],
      });
      expect(response.template.active_store_count).toBe(2);
      expect(response.sync.last_run?.id).toBe(missingRun.id);
    });

    it.each([
      'cod_confirm.en.retired',
      'metrics',
      'sync',
      'COD_CONFIRM.EN.SHORT',
      "cod_confirm.en.short'; --",
    ])('answers 404 for %p without reading anything else', async (key) => {
      const { service, metrics } = setup();

      await expect(service.detail(STAFF, key, RANGE)).rejects.toMatchObject({
        response: { statusCode: 404, code: 'WHATSAPP_TEMPLATE_NOT_FOUND' },
      });
      expect(metrics.findTemplateMetricsByPurpose).not.toHaveBeenCalled();
    });
  });
});
