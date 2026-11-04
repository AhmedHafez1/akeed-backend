import { ConnectionHealthService } from './connection-health.service';
import { connectionRow } from '../../../test/fixtures/whatsapp-connection-setup.fakes';

describe('connection health orchestration', () => {
  function setup() {
    const claim = connectionRow({
      state: 'verifying',
      healthClaimToken: 'claim',
    });
    const connections = {
      claimHealth: jest.fn().mockResolvedValue(claim),
      completeHealth: jest
        .fn()
        .mockResolvedValue({ ...claim, state: 'active' }),
      findDueHealth: jest.fn().mockResolvedValue([claim]),
    };
    const provider = {
      check: jest.fn().mockResolvedValue({ status: 'AVAILABLE' }),
    };
    const events = { emit: jest.fn().mockResolvedValue(undefined) };
    const producer = { requestHealth: jest.fn().mockResolvedValue(true) };
    const service = new ConnectionHealthService(
      connections as never,
      provider,
      events,
      producer as never,
    );
    return { service, claim, connections, provider, events, producer };
  }
  it('only calls the provider after claiming and emits activation after guarded persistence', async () => {
    const s = setup();
    await s.service.run('org-1', 'conn-1', 1);
    expect(s.provider.check).toHaveBeenCalledWith({
      orgId: 'org-1',
      connectionId: 'conn-1',
      signupGeneration: 1,
    });
    expect(s.events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'activated', orgId: 'org-1' }),
    );
  });
  it('a lost claim makes no call', async () => {
    const s = setup();
    s.connections.claimHealth.mockResolvedValue(null);
    await s.service.run('org-1', 'conn-1', 1);
    expect(s.provider.check).not.toHaveBeenCalled();
  });
  it('a stale health result emits no event', async () => {
    const s = setup();
    s.connections.completeHealth.mockResolvedValue(null);
    await s.service.run('org-1', 'conn-1', 1);
    expect(s.events.emit).not.toHaveBeenCalled();
  });
  it('transport failures persist an unknown check', async () => {
    const s = setup();
    s.provider.check.mockRejectedValue(new Error('synthetic timeout'));
    await s.service.run('org-1', 'conn-1', 1);
    expect(s.connections.completeHealth).toHaveBeenCalledWith(s.claim, {
      status: 'unknown',
    });
  });
  it('sweeps using stored tenant and generation', async () => {
    const s = setup();
    await s.service.sweep();
    expect(s.producer.requestHealth).toHaveBeenCalledWith('org-1', 'conn-1', 1);
  });
});
