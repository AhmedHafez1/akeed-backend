/** Synthetic registry templates and connection rows for own-number specs. */
import type { WhatsappConnectionTemplateRecord } from '../../src/infrastructure/database/repositories/whatsapp-connection-templates.repository';
import type { InspectedTemplate } from '../../src/infrastructure/database/repositories/whatsapp-templates.repository';
import type { TemplateComponentsSnapshot } from '../../src/shared/messaging/template-provider.types';
import type { RegistryTemplate } from '../../src/shared/messaging/template-registry.types';

export const TEXT = {
  body: 'Hello {{customer}}, confirm order {{order}}?',
  buttons: [
    { kind: 'quick_reply', text: 'Confirm' },
    { kind: 'quick_reply', text: 'Cancel' },
  ],
} satisfies TemplateComponentsSnapshot;

export function inspected(
  overrides: Partial<RegistryTemplate> & { id?: string } = {},
  components: TemplateComponentsSnapshot | null = TEXT,
): InspectedTemplate {
  const { id = 'tpl-en', ...template } = overrides;
  return {
    id,
    template: {
      key: 'cod_confirm.en.friendly',
      purpose: 'cod_confirmation',
      language: 'en',
      style: 'friendly',
      templateName: 'akeed_cod_verification_friendly',
      languageCode: 'en',
      parameterFormat: 'named',
      variables: [
        { key: 'customer', name: 'customer' },
        { key: 'order', name: 'order' },
      ],
      preview: {} as RegistryTemplate['preview'],
      isActive: true,
      isDefault: true,
      reviewStatus: 'approved',
      category: 'utility',
      lastSyncedAt: '2026-11-01T00:00:00.000Z',
      ...template,
    } as RegistryTemplate,
    quality: 'high',
    pendingCategory: null,
    providerTemplateId: '111',
    components,
    componentsDriftAt: null,
  };
}

export function row(
  overrides: Partial<WhatsappConnectionTemplateRecord> = {},
): WhatsappConnectionTemplateRecord {
  return {
    id: 'row-1',
    connectionId: 'conn-1',
    orgId: 'org-1',
    templateId: 'tpl-en',
    metaTemplateId: null,
    metaLanguageCode: 'en',
    status: 'not_submitted',
    category: null,
    quality: null,
    rejectionReason: null,
    submittedAt: null,
    statusEventAt: null,
    lastError: null,
    attempts: 0,
    nextAttemptAt: null,
    leaseUntil: null,
    submittedComponentsHash: null,
    driftAt: null,
    driftReason: null,
    lastSyncedAt: null,
    lastErrorCode: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}
