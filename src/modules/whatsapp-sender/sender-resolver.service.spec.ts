import { SenderResolverService } from './sender-resolver.service';
import { FEATURE_OFF_SENDER } from '../../shared/ports/sender-resolver.port';
import type { SelectedCodTemplate } from '../../shared/messaging/cod-template-selector';

const template: SelectedCodTemplate = {
  registryKey: 'cod_reminder.ar.egyptian_v2',
  variantKey: 'ar.egyptian_v2',
  language: 'ar',
  templateName: 'reminder_eg_v2',
  languageCode: 'ar_EG',
  parameterFormat: 'named',
  variables: [],
};

function setup(enabled = true) {
  const connections = {
    findByOrg: jest.fn().mockResolvedValue({
      id: 'connection',
      state: 'active',
      degradedClass: null,
    }),
  };
  const templates = {
    findForSend: jest
      .fn()
      .mockResolvedValue({ status: 'approved', category: 'utility' }),
  };
  const config = { get: () => ({ sendingEnabled: enabled }) };
  return {
    connections,
    templates,
    service: new SenderResolverService(
      config as never,
      connections as never,
      templates as never,
    ),
  };
}

describe('SenderResolverService', () => {
  it('makes no additional queries with sending disabled', async () => {
    const { service, connections, templates } = setup(false);
    expect(await service.resolve({ orgId: 'org', template })).toEqual(
      FEATURE_OFF_SENDER,
    );
    expect(connections.findByOrg).not.toHaveBeenCalled();
    expect(templates.findForSend).not.toHaveBeenCalled();
  });
  it('reads the exact tenant, connection and selected template on each message', async () => {
    const { service, connections, templates } = setup();
    for (let i = 0; i < 2; i++)
      expect(await service.resolve({ orgId: 'org', template })).toMatchObject({
        kind: 'merchant_own',
      });
    expect(connections.findByOrg).toHaveBeenNthCalledWith(1, 'org');
    expect(templates.findForSend).toHaveBeenCalledTimes(2);
    expect(templates.findForSend).toHaveBeenLastCalledWith(
      'org',
      'connection',
      template,
    );
  });
  it.each([
    null,
    { id: 'connection', state: 'verifying' },
    { id: 'connection', state: 'active', degradedClass: 'payment' },
  ])(
    'does not query templates for an ineligible connection %j',
    async (connection) => {
      const { service, connections, templates } = setup();
      connections.findByOrg.mockResolvedValue(connection);
      expect((await service.resolve({ orgId: 'org', template })).kind).toBe(
        'akeed_system',
      );
      expect(templates.findForSend).not.toHaveBeenCalled();
    },
  );
});
