import { ChangeRequestTemplatesService } from './change-request-templates.service';
import {
  seededRegistryTemplates,
  seededTemplateRegistry,
} from '../../shared/messaging/testing/seeded-template-registry';
import { toSelectedTemplate } from '../../shared/messaging/template-selector';
import { FEATURE_OFF_SENDER } from '../../shared/ports/sender-resolver.port';
import { CHANGE_BUTTON_LABELS } from '../../shared/messaging/change-request-messaging';

function setup() {
  const base = seededRegistryTemplates()[0];
  const sibling = {
    ...base,
    key: `${base.key}_change_v1`,
    changeRequestOfKey: base.key,
    isActive: true,
    isDefault: false,
    reviewStatus: 'approved' as const,
    category: 'utility' as const,
    lastSyncedAt: new Date().toISOString(),
    components: {
      body: 'Order',
      buttons: [
        { kind: 'quick_reply' as const, text: base.preview.confirmButton },
        { kind: 'quick_reply' as const, text: base.preview.cancelButton },
        {
          kind: 'quick_reply' as const,
          text: CHANGE_BUTTON_LABELS[base.language],
        },
      ],
    },
  };
  const connectionTemplates = {
    findForSend: jest.fn().mockResolvedValue({
      status: 'approved',
      category: 'utility',
      lastSyncedAt: new Date().toISOString(),
      driftReason: null,
    }),
  };
  const registry = seededTemplateRegistry([base, sibling]);
  const service = new ChangeRequestTemplatesService(
    registry,
    { resolve: jest.fn().mockResolvedValue(FEATURE_OFF_SENDER) },
    connectionTemplates as never,
  );
  return { service, base, sibling, connectionTemplates, registry };
}
describe('sender-specific change-request template readiness', () => {
  it('requires a matching approved three-button image twin and retains the ordinary logo fallback', async () => {
    const f = setup();
    const ordinary = {
      key: f.base.key + '_logo',
      imageTwinOfKey: f.base.key,
      twinOf: {
        templateName: f.base.templateName,
        languageCode: f.base.languageCode,
      },
      templateName: 'ordinary_logo',
      languageCode: f.base.languageCode,
      isActive: true,
      reviewStatus: 'approved' as const,
    };
    const image = {
      ...ordinary,
      key: f.sibling.key + '_logo',
      changeRequestOfKey: f.base.key,
      imageTwinOfKey: f.sibling.key,
      twinOf: {
        templateName: f.sibling.templateName,
        languageCode: f.sibling.languageCode,
      },
      templateName: 'change_logo',
      category: 'utility' as const,
      lastSyncedAt: new Date().toISOString(),
      retired: false,
      parentComponents: f.sibling.components,
      components: { ...f.sibling.components, headerImage: true as const },
      parameterFormat: f.base.parameterFormat,
      parentParameterFormat: f.base.parameterFormat,
      variables: f.base.variables,
      parentVariables: f.base.variables,
    };
    const twins = [ordinary];
    f.registry.listImageTwins = () => Promise.resolve(twins);
    const integration = {
      orgId: 'org',
      logoUrl: 'https://test.invalid/logo.png',
      logoBannerUrl: 'https://test.invalid/banner.jpg',
      logoHeaderEnabled: true,
    } as never;
    expect(
      await f.service.selectVariant(
        toSelectedTemplate(f.base),
        integration,
        FEATURE_OFF_SENDER,
      ),
    ).toMatchObject({
      ready: false,
      reason: 'change_image_twin_unavailable',
      template: { imageHeader: { templateName: 'ordinary_logo' } },
    });
    twins.push(image);
    expect(
      await f.service.selectVariant(
        toSelectedTemplate(f.base),
        integration,
        FEATURE_OFF_SENDER,
      ),
    ).toMatchObject({
      ready: true,
      template: {
        changeRequestOfKey: f.base.key,
        imageHeader: { templateName: 'change_logo' },
      },
    });
    image.components.body = 'drifted';
    expect(
      await f.service.selectVariant(
        toSelectedTemplate(f.base),
        integration,
        FEATURE_OFF_SENDER,
      ),
    ).toMatchObject({
      ready: false,
      template: { imageHeader: { templateName: 'ordinary_logo' } },
    });
  });
  it('allows own-number three-button text with a logo configured and reports no image header', async () => {
    const f = setup();
    const result = await f.service.selectVariant(
      toSelectedTemplate(f.base),
      {
        orgId: 'org',
        logoHeaderEnabled: true,
        logoBannerUrl: 'https://test.invalid/banner.jpg',
      } as never,
      {
        kind: 'merchant_own',
        connectionId: 'connection',
        reason: 'own_number',
        units: 1,
      },
    );
    expect(result.ready).toBe(true);
    expect(result.template.changeRequestOfKey).toBe(f.base.key);
    expect(result.template.imageHeader).toBeUndefined();
  });
  it('returns a specific activation block when the selected version becomes unusable', async () => {
    const f = setup();
    const integration = {
      orgId: 'org',
      defaultLanguage: f.base.language,
      codTemplateArKey: f.base.key,
      codTemplateEnKey: f.base.key,
      followUpEnabled: false,
    } as never;
    expect(await f.service.readiness(integration)).toMatchObject({
      ready: true,
    });
    f.sibling.isActive = false;
    await expect(f.service.assertReady(integration, {})).rejects.toMatchObject({
      response: {
        code: 'CHANGE_REQUEST_TEMPLATES_UNAVAILABLE',
        readiness: {
          ready: false,
          variants: [
            expect.objectContaining({ sender: 'akeed_system', ready: false }),
          ],
        },
      },
    });
  });
  it('keeps the confirmation dialect in the sent identity', async () => {
    const f = setup();
    expect(
      await f.service.counterpart(
        toSelectedTemplate(f.base),
        'org',
        FEATURE_OFF_SENDER,
      ),
    ).toMatchObject({
      variantKey: `${f.base.language}.${f.base.style}`,
      changeRequestOfKey: f.base.key,
    });
  });
  it('uses approval for the actual sender rather than inheriting the shared account status', async () => {
    const f = setup();
    Object.assign(f.sibling, { reviewStatus: 'paused' });
    expect(
      await f.service.counterpart(
        toSelectedTemplate(f.base),
        'org',
        FEATURE_OFF_SENDER,
      ),
    ).toBeNull();
    expect(
      await f.service.counterpart(toSelectedTemplate(f.base), 'org', {
        kind: 'merchant_own',
        connectionId: 'connection',
        reason: 'own_number',
        units: 1,
      }),
    ).not.toBeNull();
  });
  it.each(['missing', 'pending', 'rejected', 'paused'])(
    'blocks the merchant sender when its copy is %s even if the shared copy is approved',
    async (status) => {
      const f = setup();
      f.connectionTemplates.findForSend.mockResolvedValue({
        status,
        category: 'utility',
        lastSyncedAt: new Date().toISOString(),
        driftReason: null,
      });
      expect(
        await f.service.counterpart(toSelectedTemplate(f.base), 'org', {
          kind: 'merchant_own',
          connectionId: 'connection',
          reason: 'own_number',
          units: 1,
        }),
      ).toBeNull();
      expect(
        await f.service.counterpart(
          toSelectedTemplate(f.base),
          'org',
          FEATURE_OFF_SENDER,
        ),
      ).not.toBeNull();
    },
  );
  it('does not substitute a different style or silently accept template drift', async () => {
    const f = setup();
    expect(
      await f.service.counterpart(
        { ...toSelectedTemplate(f.base), registryKey: 'another-style' },
        'org',
        FEATURE_OFF_SENDER,
      ),
    ).toBeNull();
    f.connectionTemplates.findForSend.mockResolvedValue({
      status: 'approved',
      category: 'utility',
      lastSyncedAt: new Date().toISOString(),
      driftReason: 'components',
    });
    expect(
      await f.service.counterpart(toSelectedTemplate(f.base), 'org', {
        kind: 'merchant_own',
        connectionId: 'connection',
        reason: 'own_number',
        units: 1,
      }),
    ).toBeNull();
  });
  it('rejects a mismatched provider language even when predecessor metadata points at the selected style', async () => {
    const f = setup();
    f.sibling.languageCode = 'en_US';
    expect(
      await f.service.counterpart(
        toSelectedTemplate(f.base),
        'org',
        FEATURE_OFF_SENDER,
      ),
    ).toBeNull();
  });
});
