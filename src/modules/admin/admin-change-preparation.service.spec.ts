import { AdminChangePreparationService } from './admin-change-preparation.service';
import { seededRegistryTemplates } from '../../shared/messaging/testing/seeded-template-registry';

it('reports an unsupported source for every predecessor rather than silently omitting it', async () => {
  const base = seededRegistryTemplates()[0];
  const row = {
    ...base,
    id: 'source',
    headerFormat: 'none',
    retiredAt: null,
    changeRequestOfKey: null,
    metaTemplateName: base.templateName,
    metaLanguageCode: base.languageCode,
    variableMapping: base.variables,
    componentsSnapshot: null,
    updatedAt: '2026-11-09T00:00:00Z',
  };
  const repository = {
    inventory: jest.fn().mockResolvedValue({ templates: [row], drafts: [] }),
    prepare: jest.fn().mockResolvedValue({ results: [] }),
  };
  const service = new AdminChangePreparationService(
    repository as never,
    { describeComponents: () => null } as never,
  );
  expect(await service.prepare('operator')).toEqual({
    results: [
      {
        parent_key: base.key,
        outcome: 'blocked',
        reason: 'source_unreadable_or_unsupported',
      },
    ],
  });
  expect(repository.prepare).toHaveBeenCalledWith([], 'operator', undefined);
});

it('shows no image twin for a source without a key, even beside ordinary templates', async () => {
  const [base, other] = seededRegistryTemplates();
  const toRow = (template: typeof base, id: string) => ({
    ...template,
    id,
    headerFormat: 'none',
    retiredAt: null,
    changeRequestOfKey: null,
    // Ordinary rows read back from the database with a null twin key.
    imageTwinOfKey: null,
    metaTemplateName: template.templateName,
    metaLanguageCode: template.languageCode,
    variableMapping: template.variables,
    componentsSnapshot: null,
    updatedAt: '2026-11-09T00:00:00Z',
  });
  const repository = {
    inventory: jest.fn().mockResolvedValue({
      templates: [toRow(base, 'source'), toRow(other, 'ordinary')],
      drafts: [],
    }),
    prepare: jest.fn(),
  };
  const service = new AdminChangePreparationService(
    repository as never,
    { describeComponents: () => null } as never,
  );

  const { variants } = await service.overview();

  expect(variants).toHaveLength(2);
  for (const variant of variants) {
    expect(variant.key).toBeNull();
    expect(variant.blocked_reason).toBe('source_unreadable_or_unsupported');
    expect(variant.image_twin).toMatchObject({ key: null, state: 'planned' });
  }
});
