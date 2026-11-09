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
