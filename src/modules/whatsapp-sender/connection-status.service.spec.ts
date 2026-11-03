import type { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import type { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import type { WhatsappTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import { encryptConnectionSecret } from '../../infrastructure/spokes/meta/own-number/whatsapp-connection-credentials';
import {
  connectionRow,
  InMemoryConnections,
  InMemoryConnectionTemplates,
  registryFake,
} from '../../../test/fixtures/whatsapp-connection-setup.fakes';
import { inspected } from '../../../test/fixtures/whatsapp-connection-setup.fixtures';
import { ConnectionStatusService } from './connection-status.service';

const KEY = 'k'.repeat(32);
const TOKEN = 'EAAG-business-token-never-real';
const PIN = '482913';

describe('ConnectionStatusService', () => {
  function setup(row: Parameters<typeof connectionRow>[0] = {}) {
    const connections = new InMemoryConnections();
    const rows = new InMemoryConnectionTemplates();
    connections.add(
      connectionRow({
        businessTokenEncrypted: encryptConnectionSecret(TOKEN, KEY),
        registrationPinEncrypted: encryptConnectionSecret(PIN, KEY),
        setupStatus: 'failed',
        setupStep: 'register',
        setupErrorCode: 'register_unresolved',
        setupNextAttemptAt: '2026-11-03T11:00:00.000Z',
        ...row,
      }),
    );
    void rows.ensureRows('org-1', 'conn-1', [
      { templateId: 'tpl-en', metaLanguageCode: 'en' },
    ]);
    Object.assign(rows.rows[0], {
      status: 'rejected',
      lastError: 'Meta said: Invalid request (EAAG-business-token-never-real)',
      lastErrorCode: 'invalid_format',
    });
    const service = new ConnectionStatusService(
      connections as unknown as WhatsappConnectionsRepository,
      rows as unknown as WhatsappConnectionTemplatesRepository,
      registryFake([inspected()]) as unknown as WhatsappTemplatesRepository,
    );
    return { service };
  }

  it('shows setup progress, the retry time and template counts', async () => {
    const { service } = setup();
    await expect(service.forOrganization('org-1')).resolves.toMatchObject({
      state: 'connecting',
      setup: {
        status: 'failed',
        step: 'register',
        errorCode: 'register_unresolved',
        retryAt: '2026-11-03T11:00:00.000Z',
      },
      templates: { total: 1, rejected: 1, ready: 0 },
    });
  });

  it('answers null for an organization without a connection', async () => {
    const { service } = setup();
    await expect(service.forOrganization('org-2')).resolves.toBeNull();
    await expect(service.forStaff('org-2')).resolves.toBeNull();
  });

  it('gives staff each template by key, with codes but no provider text', async () => {
    const { service } = setup();
    const view = await service.forStaff('org-1');
    expect(view?.templateRows).toEqual([
      expect.objectContaining({
        templateKey: 'cod_confirm.en.friendly',
        status: 'rejected',
        lastErrorCode: 'invalid_format',
      }),
    ]);
    expect(view?.templateRows[0]).not.toHaveProperty('lastError');
  });

  it('never carries a token, PIN or ciphertext', async () => {
    const { service } = setup();
    for (const view of [
      await service.forOrganization('org-1'),
      await service.forStaff('org-1'),
    ]) {
      const json = JSON.stringify(view);
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain(PIN);
      expect(json).not.toContain('v1:');
      expect(json).not.toMatch(/encrypted/i);
    }
  });
});
