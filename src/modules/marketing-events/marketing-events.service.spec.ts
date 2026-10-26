import type { MetaConversionsClient } from '../../infrastructure/spokes/meta/meta-conversions.client';
import type { CompleteRegistrationDto } from './dto/complete-registration.dto';
import { sha256Hex } from './marketing-events.policy';
import {
  MarketingEventsService,
  type AccountLookup,
} from './marketing-events.service';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const USER_ID = '11111111-1111-4111-8111-111111111111';

const DTO: CompleteRegistrationDto = {
  eventId: 'evt-1',
  userId: USER_ID,
  eventSourceUrl: 'https://getakeed.com/ar/signup',
  fbp: 'fb.1.1.2',
};

const CONTEXT = { clientIp: '203.0.113.7', userAgent: 'Mozilla/5.0' };

function setup(
  account: Awaited<ReturnType<AccountLookup['getUserById']>> = {
    email: 'Sara@Example.com',
    createdAt: '2026-10-26T11:58:00Z',
  },
) {
  const conversions = {
    isEnabled: jest.fn().mockReturnValue(true),
    send: jest.fn().mockResolvedValue('sent'),
  };
  const accounts = { getUserById: jest.fn().mockResolvedValue(account) };
  const service = new MarketingEventsService(
    conversions as unknown as MetaConversionsClient,
    accounts,
  );
  return { service, conversions, accounts };
}

describe('MarketingEventsService', () => {
  it('sends CompleteRegistration with the email from the account', async () => {
    const { service, conversions, accounts } = setup();

    await expect(
      service.reportCompleteRegistration(DTO, CONTEXT, NOW),
    ).resolves.toBe('sent');

    expect(accounts.getUserById).toHaveBeenCalledWith(USER_ID);
    expect(conversions.send).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'CompleteRegistration',
        event_id: 'evt-1',
        event_source_url: 'https://getakeed.com/ar/signup',
        action_source: 'website',
        user_data: {
          em: [sha256Hex('sara@example.com')],
          external_id: [sha256Hex(USER_ID)],
          client_ip_address: '203.0.113.7',
          client_user_agent: 'Mozilla/5.0',
          fbp: 'fb.1.1.2',
        },
      }),
    );
  });

  it('does nothing when the Conversions API is off', async () => {
    const { service, conversions, accounts } = setup();
    conversions.isEnabled.mockReturnValue(false);

    await expect(
      service.reportCompleteRegistration(DTO, CONTEXT, NOW),
    ).resolves.toBe('disabled');
    expect(accounts.getUserById).not.toHaveBeenCalled();
  });

  it('skips an unknown account', async () => {
    const { service, conversions } = setup(null);
    await expect(
      service.reportCompleteRegistration(DTO, CONTEXT, NOW),
    ).resolves.toBe('unknown_user');
    expect(conversions.send).not.toHaveBeenCalled();
  });

  it('skips an account older than the window', async () => {
    const { service, conversions } = setup({
      email: 'a@b.co',
      createdAt: '2026-10-25T12:00:00Z',
    });
    await expect(
      service.reportCompleteRegistration(DTO, CONTEXT, NOW),
    ).resolves.toBe('stale_user');
    expect(conversions.send).not.toHaveBeenCalled();
  });

  it('reports an account only once, even concurrently', async () => {
    const { service, conversions } = setup();

    const outcomes = await Promise.all([
      service.reportCompleteRegistration(DTO, CONTEXT, NOW),
      service.reportCompleteRegistration(
        { ...DTO, eventId: 'evt-2' },
        CONTEXT,
        NOW,
      ),
    ]);

    expect(outcomes.sort()).toEqual(['duplicate', 'sent']);
    expect(conversions.send).toHaveBeenCalledTimes(1);
  });

  it('swallows a lookup failure', async () => {
    const { service, accounts, conversions } = setup();
    accounts.getUserById.mockRejectedValue(new Error('supabase down'));

    await expect(
      service.reportCompleteRegistration(DTO, CONTEXT, NOW),
    ).resolves.toBe('failed');
    expect(conversions.send).not.toHaveBeenCalled();
  });

  it('accepts without waiting and never rejects', () => {
    const { service, accounts } = setup();
    accounts.getUserById.mockReturnValue(new Promise(() => undefined));

    expect(service.acceptCompleteRegistration(DTO, CONTEXT)).toBeUndefined();
  });
});
