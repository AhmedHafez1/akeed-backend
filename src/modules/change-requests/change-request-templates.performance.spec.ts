import { ChangeRequestTemplatesService } from './change-request-templates.service';
import {
  authoredTemplate,
  seededTemplateRegistry,
} from '../../shared/messaging/testing/seeded-template-registry';
import {
  FEATURE_OFF_SENDER,
  type ResolvedSender,
} from '../../shared/ports/sender-resolver.port';
import { CHANGE_BUTTON_LABELS } from '../../shared/messaging/change-request-messaging';
import { toSelectedTemplate } from '../../shared/messaging/template-selector';

function setup() {
  const bases = (['ar', 'en', 'ur', 'es', 'fr', 'tr'] as const).map(
    (language) =>
      authoredTemplate(language, 'standard', {
        isDefault: true,
        isActive: true,
        reviewStatus: 'approved',
        category: 'utility',
        lastSyncedAt: '2026-11-15T00:00:00.000Z',
      }),
  );
  const siblings = bases.map((base) => ({
    ...base,
    key: base.key + '_change',
    isDefault: false,
    changeRequestOfKey: base.key,
    components: {
      body: 'Synthetic order',
      buttons: [
        { kind: 'quick_reply' as const, text: base.preview.confirmButton },
        { kind: 'quick_reply' as const, text: base.preview.cancelButton },
        {
          kind: 'quick_reply' as const,
          text: CHANGE_BUTTON_LABELS[base.language],
        },
      ],
    },
  }));
  const persisted = {
    findAll: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve([...bases, ...siblings].map((row) => ({ ...row }))),
      ),
    findImageTwins: jest.fn().mockResolvedValue([]),
  };
  const senders = { resolve: jest.fn().mockResolvedValue(FEATURE_OFF_SENDER) };
  const connectionTemplates = {
    findForSend: jest.fn().mockResolvedValue({
      status: 'approved',
      category: 'utility',
      lastSyncedAt: '2026-11-15T00:00:00.000Z',
    }),
  };
  const service = new ChangeRequestTemplatesService(
    seededTemplateRegistry(bases),
    senders,
    connectionTemplates as never,
    persisted as never,
  );
  const integration = (orgId = 'org-a') =>
    ({
      orgId,
      defaultLanguage: 'auto',
      codTemplateArAuto: false,
      followUpEnabled: false,
      logoHeaderEnabled: false,
    }) as never;
  return {
    bases,
    siblings,
    persisted,
    senders,
    connectionTemplates,
    service,
    integration,
  };
}

async function flush() {
  for (let index = 0; index < 25; index++) await Promise.resolve();
}

describe('request-scoped readiness reads', () => {
  it('reads each persisted catalog once for all languages, and re-reads after an approval changes', async () => {
    const f = setup();
    const first = await f.service.readiness(f.integration());
    expect(first.ready).toBe(true);
    expect(first.variants.map((row) => row.language)).toEqual([
      'ar',
      'en',
      'ur',
      'es',
      'fr',
      'tr',
    ]);
    expect(f.persisted.findAll).toHaveBeenCalledTimes(1);
    expect(f.persisted.findImageTwins).toHaveBeenCalledTimes(1);
    f.siblings[0].isActive = false;
    const second = await f.service.readiness(f.integration());
    expect(second.ready).toBe(false);
    expect(second.variants[0].ready).toBe(false);
    expect(f.persisted.findAll).toHaveBeenCalledTimes(2);
    expect(f.persisted.findImageTwins).toHaveBeenCalledTimes(2);
  });

  it('bounds sender reads to four and preserves output order when they finish out of order', async () => {
    const f = setup();
    let active = 0;
    let maximum = 0;
    const release: (() => void)[] = [];
    f.senders.resolve.mockImplementation(() => {
      active++;
      maximum = Math.max(maximum, active);
      return new Promise<ResolvedSender>((resolve) =>
        release.push(() => {
          active--;
          resolve(FEATURE_OFF_SENDER);
        }),
      );
    });
    const result = f.service.readiness(f.integration());
    await flush();
    expect(f.senders.resolve).toHaveBeenCalledTimes(4);
    release
      .splice(0)
      .reverse()
      .forEach((resolve) => resolve());
    await flush();
    expect(f.senders.resolve).toHaveBeenCalledTimes(6);
    release
      .splice(0)
      .reverse()
      .forEach((resolve) => resolve());
    expect((await result).variants.map((row) => row.language)).toEqual([
      'ar',
      'en',
      'ur',
      'es',
      'fr',
      'tr',
    ]);
    expect(maximum).toBe(4);
  });

  it('starts the persisted catalog read with the registry list, before any sender resolves', async () => {
    const f = setup();
    const release: (() => void)[] = [];
    f.senders.resolve.mockImplementation(
      () =>
        new Promise<ResolvedSender>((resolve) =>
          release.push(() => resolve(FEATURE_OFF_SENDER)),
        ),
    );
    const result = f.service.readiness(f.integration());
    await flush();
    expect(f.persisted.findAll).toHaveBeenCalledTimes(1);
    expect(f.persisted.findImageTwins).not.toHaveBeenCalled();
    expect(f.senders.resolve).toHaveBeenCalledTimes(4);
    release.splice(0).forEach((resolve) => resolve());
    await flush();
    release.splice(0).forEach((resolve) => resolve());
    expect((await result).ready).toBe(true);
    expect(f.persisted.findAll).toHaveBeenCalledTimes(1);
    expect(f.persisted.findImageTwins).toHaveBeenCalledTimes(1);
  });

  it('does not retain a failed catalog promise for the next evaluation', async () => {
    const f = setup();
    f.persisted.findAll.mockRejectedValueOnce(
      new Error('synthetic unavailable'),
    );
    await expect(f.service.readiness(f.integration())).rejects.toThrow(
      'synthetic unavailable',
    );
    expect((await f.service.readiness(f.integration())).ready).toBe(true);
    expect(f.persisted.findAll).toHaveBeenCalledTimes(2);
  });

  it('keeps merchant connection approvals scoped to their organization during concurrent reads', async () => {
    const f = setup();
    f.senders.resolve.mockImplementation(({ orgId }: { orgId: string }) =>
      Promise.resolve({
        kind: 'merchant_own',
        reason: 'own_number',
        connectionId: `connection-${orgId}`,
        units: 1,
      }),
    );
    f.connectionTemplates.findForSend.mockImplementation(
      (orgId: string, connectionId: string) => {
        expect(connectionId).toBe(`connection-${orgId}`);
        return Promise.resolve({
          status: orgId === 'org-a' ? 'approved' : 'paused',
          category: 'utility',
          lastSyncedAt: '2026-11-15T00:00:00.000Z',
        });
      },
    );
    const [first, second] = await Promise.all([
      f.service.readiness(f.integration('org-a')),
      f.service.readiness(f.integration('org-b')),
    ]);
    expect(first.ready).toBe(true);
    expect(second.ready).toBe(false);
    expect(f.persisted.findAll).toHaveBeenCalledTimes(2);
    expect(f.persisted.findImageTwins).not.toHaveBeenCalled();
  });

  it('keeps send-time selection fresh between individual sends', async () => {
    const f = setup();
    const base = toSelectedTemplate(f.bases[0]);
    expect(
      (await f.service.selectVariant(base, f.integration(), FEATURE_OFF_SENDER))
        .ready,
    ).toBe(true);
    f.siblings[0].isActive = false;
    expect(
      (await f.service.selectVariant(base, f.integration(), FEATURE_OFF_SENDER))
        .ready,
    ).toBe(false);
    expect(f.persisted.findAll).toHaveBeenCalledTimes(2);
  });
});
