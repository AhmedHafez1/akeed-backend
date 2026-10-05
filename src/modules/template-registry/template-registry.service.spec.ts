import { seededRegistryTemplates } from '../../shared/messaging/testing/seeded-template-registry';
import {
  TEMPLATE_REGISTRY_CACHE_TTL_MS,
  TemplateRegistryService,
} from './template-registry.service';

describe('TemplateRegistryService', () => {
  const templates = seededRegistryTemplates();

  function setup() {
    const repository = { findAll: jest.fn().mockResolvedValue(templates) };
    const service = new TemplateRegistryService(repository as never);
    return { service, repository };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-05T10:00:00.000Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('reads the registry once and serves the copy until it expires', async () => {
    const { service, repository } = setup();

    await expect(service.listTemplates()).resolves.toBe(templates);
    jest.advanceTimersByTime(TEMPLATE_REGISTRY_CACHE_TTL_MS - 1);
    await expect(service.listTemplates()).resolves.toBe(templates);

    expect(repository.findAll).toHaveBeenCalledTimes(1);
  });

  it('reads again once the copy has expired', async () => {
    const { service, repository } = setup();
    await service.listTemplates();
    const changed = templates.slice(0, 2);
    repository.findAll.mockResolvedValue(changed);

    jest.advanceTimersByTime(TEMPLATE_REGISTRY_CACHE_TTL_MS);

    await expect(service.listTemplates()).resolves.toBe(changed);
    expect(repository.findAll).toHaveBeenCalledTimes(2);
  });

  it('reads again at once after invalidate', async () => {
    const { service, repository } = setup();
    await service.listTemplates();
    const changed = templates.slice(0, 2);
    repository.findAll.mockResolvedValue(changed);

    service.invalidate();

    await expect(service.listTemplates()).resolves.toBe(changed);
    expect(repository.findAll).toHaveBeenCalledTimes(2);
  });

  it('shares one read between concurrent callers', async () => {
    const { service, repository } = setup();

    const [first, second] = await Promise.all([
      service.listTemplates(),
      service.listTemplates(),
    ]);

    expect(first).toBe(templates);
    expect(second).toBe(templates);
    expect(repository.findAll).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the last good copy when a refresh fails', async () => {
    const { service, repository } = setup();
    await service.listTemplates();
    repository.findAll.mockRejectedValue(new Error('connection lost'));
    jest.advanceTimersByTime(TEMPLATE_REGISTRY_CACHE_TTL_MS);

    await expect(service.listTemplates()).resolves.toBe(templates);

    repository.findAll.mockResolvedValue(templates.slice(0, 1));
    await expect(service.listTemplates()).resolves.toHaveLength(1);
  });

  it('fails when the first read fails: there is no copy to serve', async () => {
    const { service, repository } = setup();
    repository.findAll.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.listTemplates()).rejects.toThrow('connection lost');
    await expect(service.listTemplates()).resolves.toBe(templates);
  });
});
