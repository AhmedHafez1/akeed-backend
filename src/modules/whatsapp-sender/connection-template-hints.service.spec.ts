import { Logger } from '@nestjs/common';
import type { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import type { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import type { TemplateProviderEvent } from '../../shared/messaging/template-provider.types';
import {
  connectionRow,
  InMemoryConnections,
  InMemoryConnectionTemplates,
} from '../../../test/fixtures/whatsapp-connection-setup.fakes';
import { ConnectionTemplateHintsService } from './connection-template-hints.service';
import type { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';

const WABA_A = '102290129340398';
const WABA_B = '102290129349999';

function event(
  overrides: Partial<TemplateProviderEvent> = {},
): TemplateProviderEvent {
  return {
    field: 'status',
    identityKey: 'k1',
    occurredAt: '2026-11-03T10:00:00.000Z',
    templateName: 'akeed_cod_verification_friendly',
    languageCode: 'en',
    providerTemplateId: '7000000001',
    status: 'approved',
    ...overrides,
  };
}

describe('ConnectionTemplateHintsService', () => {
  function setup() {
    const connections = new InMemoryConnections();
    const rows = new InMemoryConnectionTemplates();
    const producer = { requestTemplateSync: jest.fn().mockResolvedValue(true) };
    connections.add(
      connectionRow({
        id: 'conn-a',
        orgId: 'org-a',
        wabaId: WABA_A,
        state: 'verifying',
      }),
    );
    connections.add(
      connectionRow({
        id: 'conn-b',
        orgId: 'org-b',
        wabaId: WABA_B,
        phoneNumberId: '106540352249999',
        state: 'verifying',
      }),
    );
    for (const [orgId, connectionId] of [
      ['org-a', 'conn-a'],
      ['org-b', 'conn-b'],
    ] as const) {
      void rows.ensureRows(orgId, connectionId, [
        { templateId: 'tpl-en', metaLanguageCode: 'en' },
      ]);
      rows.rows.at(-1)!.metaTemplateId = '7000000001';
      rows.rows.at(-1)!.status = 'pending';
    }
    const service = new ConnectionTemplateHintsService(
      connections as unknown as WhatsappConnectionsRepository,
      rows as unknown as WhatsappConnectionTemplatesRepository,
      producer as unknown as WhatsappConnectionSetupProducer,
    );
    return { service, rows, producer };
  }

  beforeEach(() => {
    for (const level of ['log', 'warn'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('writes the hint only to the connection holding that account, then queues its sync', async () => {
    const { service, rows, producer } = setup();
    await service.apply(WABA_A, [event()]);
    expect(rows.rows.find((r) => r.orgId === 'org-a')?.status).toBe('approved');
    expect(rows.rows.find((r) => r.orgId === 'org-b')?.status).toBe('pending');
    expect(producer.requestTemplateSync).toHaveBeenCalledWith('conn-a');
    expect(producer.requestTemplateSync).toHaveBeenCalledTimes(1);
  });

  it('ignores an older hint than the one applied', async () => {
    const { service, rows } = setup();
    await service.apply(WABA_A, [event()]);
    await service.apply(WABA_A, [
      event({ status: 'paused', occurredAt: '2026-11-03T09:00:00.000Z' }),
    ]);
    expect(rows.rows.find((r) => r.orgId === 'org-a')?.status).toBe('approved');
  });

  it('still queues a sync for quality and category events, which it does not write', async () => {
    const { service, rows, producer } = setup();
    await service.apply(WABA_A, [
      event({ field: 'quality', status: undefined, quality: 'low' }),
    ]);
    expect(rows.rows.find((r) => r.orgId === 'org-a')?.status).toBe('pending');
    expect(producer.requestTemplateSync).toHaveBeenCalledWith('conn-a');
  });

  it('drops events for an account no connection holds', async () => {
    const { service, producer } = setup();
    await service.apply('102290129340000', [event()]);
    expect(producer.requestTemplateSync).not.toHaveBeenCalled();
  });
});
