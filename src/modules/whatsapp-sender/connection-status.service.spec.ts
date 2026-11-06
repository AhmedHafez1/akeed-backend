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
import { ConfigService } from '@nestjs/config';
import {
  parseWhatsappOwnNumberConfig,
  WHATSAPP_OWN_NUMBER_CONFIG,
} from '../../shared/config/whatsapp-own-number.config';

const KEY = 'k'.repeat(32);
const TOKEN = 'EAAG-business-token-never-real';
const PIN = '482913';

describe('ConnectionStatusService', () => {
  function setup(
    row: Parameters<typeof connectionRow>[0] = {},
    sendingEnabled = false,
  ) {
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
      new ConfigService({
        [WHATSAPP_OWN_NUMBER_CONFIG]: parseWhatsappOwnNumberConfig(
          sendingEnabled
            ? {
                WHATSAPP_OWN_NUMBER_SENDING_ENABLED: 'true',
                SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY,
              }
            : {},
        ),
      }),
    );
    return { service, rows };
  }

  it('shows setup progress, the retry time and template counts', async () => {
    const { service } = setup();
    await expect(service.forOrganization('org-1')).resolves.toMatchObject({
      state: 'connecting',
      thankYouEnabled: true,
      setup: {
        status: 'failed',
        step: 'register',
        errorCode: 'register_unresolved',
        retryAt: '2026-11-03T11:00:00.000Z',
      },
      templates: { total: 1, rejected: 1, ready: 0 },
    });
  });

  it('lists a missing live template instead of implying the language is ready', async () => {
    const { service, rows } = setup({ state: 'active' }, true);
    rows.rows.splice(0);
    expect((await service.forOrganization('org-1'))?.templateDetails).toEqual([
      {
        key: 'cod_confirm.en.friendly',
        language: 'en',
        languageCode: 'en',
        status: 'missing',
        category: null,
        readiness: { kind: 'akeed_system', reason: 'template_missing' },
      },
    ]);
  });

  it('exposes safe per-template readiness and persisted health without provider I/O', async () => {
    const { service } = setup(
      { state: 'active', qualityRating: 'RED', degradedClass: 'payment' },
      true,
    );
    const view = await service.forOrganization('org-1');
    expect(view?.health).toMatchObject({
      qualityRating: 'RED',
      degradedClass: 'payment',
    });
    expect(view?.templateDetails[0]).toMatchObject({
      status: 'rejected',
      readiness: { kind: 'akeed_system', reason: 'degraded:payment' },
    });
  });

  it('exposes the saved disabled thank-you preference', async () => {
    await expect(
      setup({ thankYouEnabled: false }).service.forOrganization('org-1'),
    ).resolves.toMatchObject({ thankYouEnabled: false });
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
