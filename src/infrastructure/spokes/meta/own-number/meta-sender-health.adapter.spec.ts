import { MetaSenderHealthAdapter } from './meta-sender-health.adapter';
import { connectionRow } from '../../../../../test/fixtures/whatsapp-connection-setup.fakes';
import { encryptConnectionSecret } from './whatsapp-connection-credentials';

describe('merchant health credential boundary', () => {
  const key = 'c'.repeat(64);
  function setup() {
    const row = connectionRow({
      state: 'verifying',
      businessTokenEncrypted: encryptConnectionSecret(
        'synthetic-health-token',
        key,
      ),
    });
    const connections = { findByOrg: jest.fn().mockResolvedValue(row) };
    const graph = {
      readHealth: jest.fn().mockResolvedValue({ status: 'AVAILABLE' }),
    };
    const adapter = new MetaSenderHealthAdapter(
      connections as never,
      graph as never,
      { get: () => key } as never,
    );
    return { adapter, connections, graph, row };
  }
  it('decrypts only at the spoke and reads the claimed phone', async () => {
    const s = setup();
    await expect(
      s.adapter.check({
        orgId: 'org-1',
        connectionId: 'conn-1',
        signupGeneration: 1,
      }),
    ).resolves.toEqual({ status: 'AVAILABLE' });
    expect(s.graph.readHealth).toHaveBeenCalledWith(
      s.row.phoneNumberId,
      'synthetic-health-token',
    );
  });
  it.each([
    { connectionId: 'other', signupGeneration: 1 },
    { connectionId: 'conn-1', signupGeneration: 2 },
  ])('rejects stale identity %j before provider IO', async (identity) => {
    const s = setup();
    expect(await s.adapter.check({ orgId: 'org-1', ...identity })).toEqual({
      status: 'unknown',
    });
    expect(s.graph.readHealth).not.toHaveBeenCalled();
  });
  it('does not call provider with unreadable credentials', async () => {
    const s = setup();
    s.row.businessTokenEncrypted = 'plaintext';
    const result = await s.adapter.check({
      orgId: 'org-1',
      connectionId: 'conn-1',
      signupGeneration: 1,
    });
    expect(result).toMatchObject({
      status: 'BLOCKED',
      failure: { class: 'credentials' },
    });
    expect(s.graph.readHealth).not.toHaveBeenCalled();
  });
});
