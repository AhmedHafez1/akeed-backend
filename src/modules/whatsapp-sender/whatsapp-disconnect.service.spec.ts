import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { WhatsappDisconnectService } from './whatsapp-disconnect.service';
import { encryptConnectionSecret } from '../../infrastructure/spokes/meta/own-number/whatsapp-connection-credentials';

const key = 'c'.repeat(64);
const owner = { orgId: 'org-a', role: 'owner' } as never;
function setup() {
  const connections = {
    beginDisconnect: jest.fn().mockResolvedValue({
      id: 'connection',
      signupGeneration: 2,
      wabaId: '100',
      signupPath: 'coexistence',
      businessTokenEncrypted: encryptConnectionSecret(
        'synthetic-business-token',
        key,
      ),
    }),
    finishDisconnect: jest.fn().mockResolvedValue(undefined),
    findByOrg: jest.fn().mockResolvedValue(null),
  };
  const graph = { unsubscribeApp: jest.fn().mockResolvedValue({ ok: true }) };
  const service = new WhatsappDisconnectService(
    connections as never,
    graph as never,
    new ConfigService({ SHOPIFY_TOKEN_ENCRYPTION_KEY: key }),
  );
  return { connections, graph, service };
}
describe('merchant disconnect', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());
  it('commits local disconnect before one unsubscribe, with typed app steps', async () => {
    const s = setup();
    const result = await s.service.disconnect(owner);
    expect(
      s.connections.beginDisconnect.mock.invocationCallOrder[0],
    ).toBeLessThan(s.graph.unsubscribeApp.mock.invocationCallOrder[0]);
    expect(s.graph.unsubscribeApp).toHaveBeenCalledTimes(1);
    expect(s.connections.finishDisconnect).toHaveBeenCalledWith(
      'org-a',
      'connection',
      2,
      'succeeded',
    );
    expect(result).toEqual({
      state: 'disconnected',
      providerCleanup: 'succeeded',
      businessAppSteps: [
        'settings',
        'account',
        'business_platform',
        'disconnect',
      ],
    });
  });
  it.each(['rejected', 'timeout', 'throws', 'unreadable_token'])(
    'keeps the local disconnect on %s',
    async (kind) => {
      const s = setup();
      if (kind === 'throws')
        s.graph.unsubscribeApp.mockRejectedValue(new Error('provider failure'));
      else if (kind === 'unreadable_token')
        s.connections.beginDisconnect.mockResolvedValue({
          id: 'connection',
          signupGeneration: 2,
          signupPath: 'coexistence',
          businessTokenEncrypted: 'broken',
        } as never);
      else
        s.graph.unsubscribeApp.mockResolvedValue({ ok: false, kind } as never);
      expect(await s.service.disconnect(owner)).toMatchObject({
        state: 'disconnected',
        providerCleanup: 'manual_required',
      });
      expect(s.connections.finishDisconnect).toHaveBeenCalledWith(
        'org-a',
        'connection',
        2,
        'manual_required',
      );
    },
  );
  it.each(['viewer', 'admin'])(
    'refuses %s before database or provider side effects',
    async (role) => {
      const s = setup();
      await expect(
        s.service.disconnect({ orgId: 'org-a', role } as never),
      ).rejects.toMatchObject({
        response: { code: 'WHATSAPP_CONNECTION_OWNER_REQUIRED' },
      });
      expect(s.connections.beginDisconnect).not.toHaveBeenCalled();
      expect(s.graph.unsubscribeApp).not.toHaveBeenCalled();
    },
  );
  it('is idempotent and works with connection switches absent', async () => {
    const s = setup();
    s.connections.beginDisconnect.mockResolvedValue(null as never);
    expect(await s.service.disconnect(owner)).toEqual({
      state: 'disconnected',
      providerCleanup: 'not_needed',
      businessAppSteps: [],
    });
    expect(s.graph.unsubscribeApp).not.toHaveBeenCalled();
  });
});
