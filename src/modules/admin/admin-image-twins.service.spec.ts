import { HttpException, Logger } from '@nestjs/common';
import { parseWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import { describeMetaComponents } from '../../infrastructure/spokes/meta/meta-template-text';
import type { InspectedTemplate } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import type { TemplateComponentsSnapshot } from '../../shared/messaging/template-provider.types';
import type { ImageTwinTemplate } from '../../shared/messaging/template-registry.types';
import { seededRegistryTemplates } from '../../shared/messaging/testing/seeded-template-registry';
import { TemplateSubmissionError } from '../../shared/ports/template-catalog.port';
import {
  AdminImageTwinsService,
  IMAGE_TWIN_AUDIT_ACTIONS,
} from './admin-image-twins.service';

const STAFF = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

/** A snapshot that fills every variable of the template, as a sync stores it. */
function snapshotFor(
  template: InspectedTemplate['template'],
): TemplateComponentsSnapshot {
  const placeholders = template.variables.map((variable, index) =>
    template.parameterFormat === 'named'
      ? `{{${variable.name ?? variable.key}}}`
      : `{{${index + 1}}}`,
  );
  return {
    body: `Order ${placeholders.join(' ')}`,
    buttons: [
      { kind: 'quick_reply', text: 'Yes' },
      { kind: 'quick_reply', text: 'No' },
    ],
  };
}

function inspected(count: number): InspectedTemplate[] {
  return seededRegistryTemplates()
    .slice(0, count)
    .map((template) => ({
      id: template.key,
      template: { ...template, category: 'utility' },
      quality: null,
      pendingCategory: null,
      providerTemplateId: null,
      components: snapshotFor(template),
      componentsDriftAt: null,
    }));
}

function setup({
  parents = inspected(3),
  twins = [] as ImageTwinTemplate[],
  providerNames = [] as { templateName: string; languageCode: string }[],
  env = { META_APP_ID: '200000000000002' } as Record<string, string>,
} = {}) {
  const templates = {
    findAllForInspection: jest.fn().mockResolvedValue(parents),
    findImageTwins: jest.fn().mockResolvedValue(twins),
    findRetiredKeys: jest.fn().mockResolvedValue([]),
    registerImageTwin: jest.fn().mockResolvedValue('registered'),
    activateApprovedImageTwins: jest.fn().mockResolvedValue([]),
  };
  let created = 0;
  const catalog = {
    listTemplates: jest
      .fn()
      .mockResolvedValue(providerNames.map((identity) => ({ ...identity }))),
    describeComponents: jest.fn((snapshot: TemplateComponentsSnapshot | null) =>
      describeMetaComponents(snapshot),
    ),
    uploadSampleImage: jest.fn().mockResolvedValue('4::handle'),
    createImageTwin: jest.fn(() => {
      created += 1;
      return Promise.resolve({
        providerTemplateId: String(1000 + created),
        status: 'pending' as const,
        category: 'utility' as const,
      });
    }),
  };
  const registry = { invalidate: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const images = {
    render: jest
      .fn()
      .mockResolvedValue({ logo: Buffer.from('l'), banner: Buffer.from('b') }),
  };
  const values: Record<string, unknown> = {
    whatsappTemplates: parseWhatsappTemplateConfig(env),
  };
  const service = new AdminImageTwinsService(
    templates as never,
    catalog as never,
    registry as never,
    audit as never,
    images as never,
    { get: (key: string) => values[key] } as never,
  );
  return { service, templates, catalog, registry, audit, images };
}

async function errorCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HttpException) {
      return (error.getResponse() as { code: string }).code;
    }
    throw error;
  }
  return 'no error';
}

async function errorBody(
  work: Promise<unknown>,
): Promise<Record<string, unknown>> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getResponse() as Record<string, unknown>;
    }
    throw error;
  }
  return {};
}

const run = { userId: STAFF, requestId: 'req-1' };

describe('AdminImageTwinsService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('uploads one sample, creates and registers a twin per template', async () => {
    const { service, catalog, templates, registry, audit } = setup();

    const { results } = await service.createMissing(run);

    expect(catalog.uploadSampleImage).toHaveBeenCalledTimes(1);
    expect(catalog.uploadSampleImage).toHaveBeenCalledWith(
      Buffer.from('b'),
      'image/jpeg',
    );
    expect(catalog.createImageTwin).toHaveBeenCalledTimes(3);
    expect(results.map((result) => result.outcome)).toEqual([
      'created',
      'created',
      'created',
    ]);
    const [parentKey, twin] = templates.registerImageTwin.mock
      .calls[0] as unknown[];
    expect(parentKey).toBe(results[0].parent_key);
    expect(twin).toEqual({
      templateName: `${results[0].parent_template_name}_logo`,
      providerTemplateId: '1001',
      reviewStatus: 'pending',
      category: 'utility',
    });
    expect(
      catalog.createImageTwin.mock.calls.map(
        (call: unknown[]) => (call[0] as { headerHandle: string }).headerHandle,
      ),
    ).toEqual(['4::handle', '4::handle', '4::handle']);
    expect(registry.invalidate).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith({
      userId: STAFF,
      action: IMAGE_TWIN_AUDIT_ACTIONS.create,
      outcome: 'allowed',
      requestId: 'req-1',
      metadata: {
        created: 3,
        adopted: 0,
        skipped: 0,
        failed: 0,
        unresolved: 0,
        not_attempted: 0,
      },
    });
  });

  it('creates nothing and uploads nothing on a second run', async () => {
    const parents = inspected(2);
    const { service, catalog } = setup({
      parents,
      twins: parents.map(({ template }) => ({
        imageTwinOfKey: template.key,
        twinOf: {
          templateName: template.templateName,
          languageCode: template.languageCode,
        },
        templateName: `${template.templateName}_logo`,
        languageCode: template.languageCode,
        isActive: false,
        reviewStatus: 'pending',
      })),
    });

    const { results } = await service.createMissing(run);

    expect(results.map((result) => result.reason)).toEqual([
      'has_twin',
      'has_twin',
    ]);
    expect(catalog.uploadSampleImage).not.toHaveBeenCalled();
    expect(catalog.createImageTwin).not.toHaveBeenCalled();
  });

  it('adopts a twin the provider already holds without sending it again', async () => {
    const [parent] = inspected(1);
    const { service, catalog, templates } = setup({
      parents: [parent],
      providerNames: [
        {
          templateName: `${parent.template.templateName}_logo`,
          languageCode: parent.template.languageCode,
        },
      ],
    });

    const { results } = await service.createMissing(run);

    expect(results[0].outcome).toBe('adopted');
    expect(catalog.createImageTwin).not.toHaveBeenCalled();
    expect(templates.registerImageTwin).toHaveBeenCalledWith(
      parent.template.key,
      {
        templateName: `${parent.template.templateName}_logo`,
        providerTemplateId: null,
        reviewStatus: null,
        category: null,
      },
    );
  });

  it('stops at a rate limit and marks the rest not attempted', async () => {
    const { service, catalog, templates } = setup();
    catalog.createImageTwin
      .mockImplementationOnce(() =>
        Promise.resolve({
          providerTemplateId: '1',
          status: 'pending' as const,
          category: 'utility' as const,
        }),
      )
      .mockImplementationOnce(() =>
        Promise.reject(
          new TemplateSubmissionError('rate_limited', false, 80007),
        ),
      );

    const { results } = await service.createMissing(run);

    expect(results.map((result) => result.outcome)).toEqual([
      'created',
      'failed',
      'not_attempted',
    ]);
    expect(results[1]).toMatchObject({
      reason: 'rate_limited',
      provider_code: 80007,
    });
    expect(catalog.createImageTwin).toHaveBeenCalledTimes(2);
    expect(templates.registerImageTwin).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a refusal about one template', async () => {
    const { service, catalog } = setup();
    catalog.createImageTwin.mockImplementationOnce(() =>
      Promise.reject(
        new TemplateSubmissionError('invalid_parameter', false, 100),
      ),
    );

    const { results } = await service.createMissing(run);

    expect(results.map((result) => result.outcome)).toEqual([
      'failed',
      'created',
      'created',
    ]);
  });

  it('does not register an unresolved twin', async () => {
    const [parent] = inspected(1);
    const { service, catalog, templates } = setup({ parents: [parent] });
    catalog.createImageTwin.mockImplementationOnce(() =>
      Promise.reject(new TemplateSubmissionError('unresolved', true)),
    );

    const { results } = await service.createMissing(run);

    expect(results[0].outcome).toBe('unresolved');
    expect(templates.registerImageTwin).not.toHaveBeenCalled();
  });

  it('refuses to run without META_APP_ID, before calling the provider', async () => {
    const { service, catalog } = setup({ env: {} });
    expect(await errorCode(service.createMissing(run))).toBe(
      'WHATSAPP_TEMPLATE_IMAGE_TWIN_NOT_CONFIGURED',
    );
    expect(catalog.listTemplates).not.toHaveBeenCalled();
  });

  it('stops when the sample upload fails, creating nothing, and says why', async () => {
    const { service, catalog } = setup();
    catalog.uploadSampleImage.mockRejectedValue(
      new TemplateSubmissionError('permission_denied', false, 200),
    );
    expect(await errorBody(service.createMissing(run))).toMatchObject({
      code: 'WHATSAPP_TEMPLATE_IMAGE_TWIN_UPLOAD_FAILED',
      reason: 'permission_denied',
      provider_code: 200,
    });
    expect(catalog.createImageTwin).not.toHaveBeenCalled();
  });

  it("reports the adapter's own reason when Meta did not refuse", async () => {
    const { service, catalog } = setup();
    catalog.uploadSampleImage.mockRejectedValue(
      new TemplateSubmissionError(
        'unresolved',
        false,
        undefined,
        undefined,
        'upload_session_unreadable',
      ),
    );
    expect(await errorBody(service.createMissing(run))).toMatchObject({
      reason: 'upload_session_unreadable',
      provider_code: null,
    });
  });

  it('activates only the approved twins and reports the rest', async () => {
    const { service, templates, registry, audit } = setup();
    templates.activateApprovedImageTwins.mockResolvedValue([
      'cod_confirm.ar.standard_logo',
    ]);
    templates.findImageTwins.mockResolvedValue([
      {
        imageTwinOfKey: 'cod_confirm.ar.standard',
        twinOf: { templateName: 'a', languageCode: 'ar' },
        templateName: 'a_logo',
        languageCode: 'ar',
        isActive: true,
        reviewStatus: 'approved',
      },
      {
        imageTwinOfKey: 'cod_confirm.en.friendly',
        twinOf: { templateName: 'b', languageCode: 'en' },
        templateName: 'b_logo',
        languageCode: 'en',
        isActive: false,
        reviewStatus: 'pending',
      },
    ]);

    await expect(service.activateApproved(run)).resolves.toEqual({
      activated: ['cod_confirm.ar.standard_logo'],
      waiting: [{ key: 'cod_confirm.en.friendly', review_status: 'pending' }],
    });
    expect(registry.invalidate).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: IMAGE_TWIN_AUDIT_ACTIONS.activate,
        metadata: { activated: ['cod_confirm.ar.standard_logo'], waiting: 1 },
      }),
    );
  });

  it('lists each template with its twin', async () => {
    const parents = inspected(2);
    const { service } = setup({
      parents,
      twins: [
        {
          imageTwinOfKey: parents[0].template.key,
          twinOf: { templateName: 'x', languageCode: 'ar' },
          templateName: 'x_logo',
          languageCode: 'ar',
          isActive: true,
          reviewStatus: 'approved',
        },
      ],
    });
    const overview = await service.overview();
    expect(overview.meta_app_configured).toBe(true);
    expect(overview.parents.map((parent) => parent.twin)).toEqual([
      { template_name: 'x_logo', is_active: true, review_status: 'approved' },
      null,
    ]);
  });
});
