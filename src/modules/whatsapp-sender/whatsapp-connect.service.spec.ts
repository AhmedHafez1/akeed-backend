import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MembershipsRepository } from '../../infrastructure/database/repositories/memberships.repository';
import type { WhatsappConnectTicketsRepository } from '../../infrastructure/database/repositories/whatsapp-connect-tickets.repository';
import {
  WhatsappPhoneNumberInUseError,
  type SaveSignupConnectionInput,
  type WhatsappConnectionsRepository,
} from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import type { WhatsappConnectionState } from '../../infrastructure/database/schema';
import { OwnNumberGraphClient } from '../../infrastructure/spokes/meta/own-number/own-number-graph.client';
import { readBusinessToken } from '../../infrastructure/spokes/meta/own-number/whatsapp-connection-credentials';
import { hashInstallToken } from '../../shared/commerce/install-token';
import {
  META_GRAPH_CONFIG,
  parseMetaGraphConfig,
} from '../../shared/config/meta-graph.config';
import {
  parseWhatsappOwnNumberConfig,
  WHATSAPP_OWN_NUMBER_CONFIG,
} from '../../shared/config/whatsapp-own-number.config';
import type { OrganizationRole } from '../auth/organization-role';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  createMetaSignupFake,
  defaultSignupState,
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  FAKE_BUSINESS_TOKEN,
  FAKE_CODE,
  FAKE_DISPLAY_PHONE_NUMBER,
  FAKE_PHONE_NUMBER_ID,
  FAKE_WABA_ID,
  type FakeMetaSignupState,
} from '../../../test/contracts/meta-signup-fake';
import {
  CONNECT_TICKET_TTL_SECONDS,
  SIGNUP_TICKET_TTL_SECONDS,
  WhatsappConnectService,
} from './whatsapp-connect.service';

const ORG = '0b9f6f7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_ORG = '5a4f3e2d-1c0b-4a9f-8e7d-6c5b4a3f2e1d';
const USER = '7c6b5a4f-3e2d-4c1b-9a8f-7e6d5c4b3a2f';
const KEY = 'k'.repeat(32);
const BASE = 'https://app.example.test';

const connectOn = {
  WHATSAPP_OWN_NUMBER_CONNECT_ENABLED: 'true',
  META_EMBEDDED_SIGNUP_CONFIG_ID: '1234567890',
  META_APP_ID: FAKE_APP_ID,
  WHATSAPP_CONNECT_PAGE_BASE_URL: BASE,
  SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY,
};

interface StoredTicket {
  orgId: string;
  userId: string;
  ttlSeconds: number;
  used: boolean;
  expired: boolean;
}

/** The repositories' observable behaviour, in memory; the SQL is proven by the contract suite. */
function fakes(state: FakeMetaSignupState) {
  const tickets = new Map<string, StoredTicket>();
  const connectionRows = new Map<
    string,
    { state: WhatsappConnectionState } & Partial<SaveSignupConnectionInput>
  >();
  const roles = new Map<string, OrganizationRole>([
    [`${ORG}:${USER}`, 'owner'],
  ]);

  const ticketsRepo = {
    issue: jest.fn(
      (input: {
        orgId: string;
        userId: string;
        tokenHash: string;
        ttlSeconds: number;
        revokeOtherUnused?: boolean;
      }) => {
        if (input.revokeOtherUnused)
          for (const ticket of tickets.values())
            if (ticket.orgId === input.orgId) ticket.used = true;
        tickets.set(input.tokenHash, {
          orgId: input.orgId,
          userId: input.userId,
          ttlSeconds: input.ttlSeconds,
          used: false,
          expired: false,
        });
        return Promise.resolve({
          id: input.tokenHash,
          expiresAt: new Date(
            Date.now() + input.ttlSeconds * 1000,
          ).toISOString(),
        });
      },
    ),
    consume: jest.fn(
      (tokenHash: string, options: { lifetimeSeconds?: number } = {}) => {
        const ticket = tickets.get(tokenHash);
        if (
          !ticket ||
          ticket.used ||
          ticket.expired ||
          (options.lifetimeSeconds !== undefined &&
            ticket.ttlSeconds !== options.lifetimeSeconds)
        )
          return Promise.resolve(null);
        ticket.used = true;
        return Promise.resolve({ orgId: ticket.orgId, userId: ticket.userId });
      },
    ),
  };

  const connectionsRepo = {
    findByOrg: jest.fn((orgId: string) =>
      Promise.resolve(connectionRows.get(orgId) ?? null),
    ),
    saveSignupForOrg: jest.fn(
      (orgId: string, input: SaveSignupConnectionInput) => {
        for (const [other, row] of connectionRows)
          if (
            other !== orgId &&
            row.state !== 'disconnected' &&
            row.phoneNumberId === input.phoneNumberId
          )
            return Promise.reject(new WhatsappPhoneNumberInUseError());
        const existing = connectionRows.get(orgId);
        if (
          existing &&
          !['connecting', 'disconnected'].includes(existing.state)
        )
          return Promise.resolve({
            saved: false as const,
            reason: 'connection_exists' as const,
          });
        const row = { ...input, state: 'connecting' as const, id: 'conn-1' };
        connectionRows.set(orgId, row);
        return Promise.resolve({ saved: true as const, connection: row });
      },
    ),
  };

  const membershipsRepo = {
    findByOrgAndUser: jest.fn((orgId: string, userId: string) => {
      const role = roles.get(`${orgId}:${userId}`);
      return Promise.resolve(role ? { orgId, userId, role } : undefined);
    }),
  };

  const meta = createMetaSignupFake(state);
  return {
    tickets,
    connectionRows,
    roles,
    ticketsRepo,
    connectionsRepo,
    membershipsRepo,
    meta,
  };
}

describe('WhatsappConnectService', () => {
  let logs: string[];

  function setup(
    env: Record<string, string> = connectOn,
    state: FakeMetaSignupState = defaultSignupState(),
  ) {
    const f = fakes(state);
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(f.meta.fetch as typeof fetch);
    const config = new ConfigService({
      ...env,
      META_APP_SECRET: FAKE_APP_SECRET,
      [WHATSAPP_OWN_NUMBER_CONFIG]: parseWhatsappOwnNumberConfig(env),
      [META_GRAPH_CONFIG]: parseMetaGraphConfig({}),
    });
    const service = new WhatsappConnectService(
      config,
      f.ticketsRepo as unknown as WhatsappConnectTicketsRepository,
      f.connectionsRepo as unknown as WhatsappConnectionsRepository,
      f.membershipsRepo as unknown as MembershipsRepository,
      new OwnNumberGraphClient(config),
    );
    return { service, ...f };
  }

  const owner = (orgId = ORG): AuthenticatedUser => ({
    userId: USER,
    orgId,
    role: 'owner',
    source: 'supabase',
  });

  /** Issue, read the ticket out of the link, and claim it, as the page does. */
  async function claimed(s: ReturnType<typeof setup>) {
    const issued = await s.service.issueTicket(owner(), 'ar');
    const ticket = new URL(issued.connectUrl).searchParams.get('ticket')!;
    return s.service.claimTicket(ticket);
  }

  const complete = (
    s: ReturnType<typeof setup>,
    signupTicket: string,
    extra: Record<string, unknown> = {},
  ) =>
    s.service.completeSignup({
      signupTicket,
      code: FAKE_CODE,
      wabaIds: [FAKE_WABA_ID],
      phoneNumberId: FAKE_PHONE_NUMBER_ID,
      ...extra,
    });

  async function expectCode(promise: Promise<unknown>, code: string) {
    const error: unknown = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getResponse()).toMatchObject({ code });
  }

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logs.push(String(args[0]));
        });
  });

  afterEach(() => jest.restoreAllMocks());

  describe('issueTicket', () => {
    it('gives an owner a 10-minute link on the configured origin, storing only a hash', async () => {
      const s = setup();
      const issued = await s.service.issueTicket(owner(), 'ur');
      const url = new URL(issued.connectUrl);
      expect(url.origin).toBe(BASE);
      expect(url.pathname).toBe('/ur/whatsapp/connect');
      const ticket = url.searchParams.get('ticket')!;
      expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(s.ticketsRepo.issue).toHaveBeenCalledWith({
        orgId: ORG,
        userId: USER,
        tokenHash: hashInstallToken(ticket),
        ttlSeconds: CONNECT_TICKET_TTL_SECONDS,
        revokeOtherUnused: true,
      });
      expect(s.tickets.has(ticket)).toBe(false);
      expect(logs.join('\n')).not.toContain(ticket);
    });

    it.each(['admin', 'viewer'] as const)('refuses a %s', async (role) => {
      const s = setup();
      await expectCode(
        s.service.issueTicket({ ...owner(), role }, 'ar'),
        'WHATSAPP_CONNECTION_OWNER_REQUIRED',
      );
      expect(s.ticketsRepo.issue).not.toHaveBeenCalled();
    });

    it('is unavailable with the switch off', async () => {
      const s = setup({});
      await expectCode(
        s.service.issueTicket(owner(), 'ar'),
        'WHATSAPP_CONNECT_UNAVAILABLE',
      );
      expect(s.ticketsRepo.issue).not.toHaveBeenCalled();
    });

    it.each([ORG, OTHER_ORG])(
      'issues and claims a ticket for organization %s despite a retired allowlist',
      async (orgId) => {
        const s = setup({
          ...connectOn,
          WHATSAPP_OWN_NUMBER_PILOT_ORG_IDS: 'not-a-uuid',
        });
        s.roles.set(`${orgId}:${USER}`, 'owner');
        const issued = await s.service.issueTicket(owner(orgId), 'ar');
        const ticket = new URL(issued.connectUrl).searchParams.get('ticket')!;
        await expect(s.service.claimTicket(ticket)).resolves.toBeDefined();
        expect(s.ticketsRepo.issue).toHaveBeenCalledWith(
          expect.objectContaining({ orgId, userId: USER }),
        );
        expect(s.membershipsRepo.findByOrgAndUser).toHaveBeenCalledWith(
          orgId,
          USER,
        );
        expect(s.connectionsRepo.findByOrg).toHaveBeenCalledWith(orgId);
      },
    );

    it.each(['verifying', 'active', 'offboarded'] as const)(
      'refuses while a connection is %s',
      async (state) => {
        const s = setup();
        s.connectionRows.set(ORG, { state });
        await expectCode(
          s.service.issueTicket(owner(), 'ar'),
          'WHATSAPP_CONNECTION_EXISTS',
        );
      },
    );

    it.each(['connecting', 'disconnected'] as const)(
      'allows a fresh start over a %s connection',
      async (state) => {
        const s = setup();
        s.connectionRows.set(ORG, { state });
        await expect(
          s.service.issueTicket(owner(), 'ar'),
        ).resolves.toBeDefined();
      },
    );
  });

  describe('claimTicket', () => {
    it('trades the link ticket once for a 30-minute signup ticket and the launch settings', async () => {
      const s = setup();
      const issued = await s.service.issueTicket(owner(), 'ar');
      const ticket = new URL(issued.connectUrl).searchParams.get('ticket')!;
      const result = await s.service.claimTicket(ticket);
      expect(result).toMatchObject({
        appId: FAKE_APP_ID,
        configId: '1234567890',
        graphApiVersion: 'v26.0',
      });
      expect(result.signupTicket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(s.ticketsRepo.issue).toHaveBeenLastCalledWith(
        expect.objectContaining({ ttlSeconds: SIGNUP_TICKET_TTL_SECONDS }),
      );
      await expectCode(
        s.service.claimTicket(ticket),
        'WHATSAPP_CONNECT_TICKET_INVALID',
      );
    });

    it('answers the same for an unknown, expired or replayed ticket', async () => {
      const s = setup();
      const issued = await s.service.issueTicket(owner(), 'ar');
      const ticket = new URL(issued.connectUrl).searchParams.get('ticket')!;
      s.tickets.get(hashInstallToken(ticket))!.expired = true;
      await expectCode(
        s.service.claimTicket(ticket),
        'WHATSAPP_CONNECT_TICKET_INVALID',
      );
      await expectCode(
        s.service.claimTicket('A'.repeat(43)),
        'WHATSAPP_CONNECT_TICKET_INVALID',
      );
    });

    it('refuses a signup ticket where a link ticket belongs', async () => {
      const s = setup();
      const { signupTicket } = await claimed(s);
      await expectCode(
        s.service.claimTicket(signupTicket),
        'WHATSAPP_CONNECT_TICKET_INVALID',
      );
    });

    it('rechecks the owner role and the switch', async () => {
      const s = setup();
      const issued = await s.service.issueTicket(owner(), 'ar');
      s.roles.set(`${ORG}:${USER}`, 'admin');
      await expectCode(
        s.service.claimTicket(
          new URL(issued.connectUrl).searchParams.get('ticket')!,
        ),
        'WHATSAPP_CONNECTION_OWNER_REQUIRED',
      );
    });
  });

  describe('completeSignup', () => {
    it('verifies the token and assets, then stores ciphertext in state connecting', async () => {
      const s = setup();
      const { signupTicket } = await claimed(s);
      const result = await complete(s, signupTicket, { isOnBusinessApp: true });
      expect(result).toEqual({
        state: 'connecting',
        displayPhoneNumber: FAKE_DISPLAY_PHONE_NUMBER,
        signupPath: 'coexistence',
      });
      const row = s.connectionRows.get(ORG)!;
      expect(row).toMatchObject({
        wabaId: FAKE_WABA_ID,
        phoneNumberId: FAKE_PHONE_NUMBER_ID,
      });
      expect(row.businessTokenEncrypted).toMatch(/^v1:/);
      expect(
        readBusinessToken(
          { businessTokenEncrypted: row.businessTokenEncrypted! },
          KEY,
        ),
      ).toBe(FAKE_BUSINESS_TOKEN);
      const everything = JSON.stringify(result) + logs.join('\n');
      for (const secret of [
        FAKE_BUSINESS_TOKEN,
        FAKE_CODE,
        FAKE_APP_SECRET,
        signupTicket,
      ])
        expect(everything).not.toContain(secret);
      expect(s.meta.requests.map((r) => r.path)).toEqual([
        '/oauth/access_token',
        '/debug_token',
        `/${FAKE_WABA_ID}/phone_numbers`,
      ]);
    });

    it('resolves the assets from the token alone when the page had no session info', async () => {
      const s = setup();
      const { signupTicket } = await claimed(s);
      await expect(
        s.service.completeSignup({ signupTicket, code: FAKE_CODE }),
      ).resolves.toMatchObject({ signupPath: 'new_number' });
    });

    it('spends the signup ticket once: a replay is refused before Meta is called', async () => {
      const s = setup();
      const { signupTicket } = await claimed(s);
      await complete(s, signupTicket);
      const calls = s.meta.requests.length;
      await expectCode(
        complete(s, signupTicket),
        'WHATSAPP_CONNECT_TICKET_INVALID',
      );
      expect(s.meta.requests).toHaveLength(calls);
    });

    it('lets one of two simultaneous completions with one ticket through', async () => {
      const s = setup();
      const { signupTicket } = await claimed(s);
      const results = await Promise.allSettled([
        complete(s, signupTicket),
        complete(s, signupTicket),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        s.meta.requests.filter((r) => r.path === '/oauth/access_token'),
      ).toHaveLength(1);
    });

    it('rechecks ownership and the switch before calling Meta', async () => {
      const s = setup();
      const { signupTicket } = await claimed(s);
      s.roles.delete(`${ORG}:${USER}`);
      await expectCode(
        complete(s, signupTicket),
        'WHATSAPP_CONNECTION_OWNER_REQUIRED',
      );
      expect(s.meta.requests).toHaveLength(0);

      const off = setup({
        ...connectOn,
        WHATSAPP_OWN_NUMBER_CONNECT_ENABLED: 'false',
      });
      off.tickets.set(hashInstallToken('B'.repeat(43)), {
        orgId: ORG,
        userId: USER,
        ttlSeconds: SIGNUP_TICKET_TTL_SECONDS,
        used: false,
        expired: false,
      });
      await expectCode(
        complete(off, 'B'.repeat(43)),
        'WHATSAPP_CONNECT_UNAVAILABLE',
      );
      expect(off.meta.requests).toHaveLength(0);
    });

    it('refuses when a connection went live while the merchant was in Meta’s flow', async () => {
      const s = setup();
      const { signupTicket } = await claimed(s);
      s.connectionRows.set(ORG, { state: 'active' });
      await expectCode(complete(s, signupTicket), 'WHATSAPP_CONNECTION_EXISTS');
      expect(s.meta.requests).toHaveLength(0);
    });

    it('refuses an invalid code without retrying it', async () => {
      const s = setup();
      const { signupTicket } = await claimed(s);
      await expectCode(
        complete(s, signupTicket, { code: 'AQD-not-valid' }),
        'WHATSAPP_SIGNUP_CODE_REJECTED',
      );
      expect(s.meta.requests).toHaveLength(1);
      expect(s.connectionRows.has(ORG)).toBe(false);
    });

    it.each([
      [{ kind: 'network' } as const],
      [{ kind: 'server_error', httpStatus: 503 } as const],
    ])('answers provider-unavailable for %o', async (failure) => {
      const state = defaultSignupState();
      state.failures.exchange = failure;
      const s = setup(connectOn, state);
      const { signupTicket } = await claimed(s);
      await expectCode(
        complete(s, signupTicket),
        'WHATSAPP_SIGNUP_PROVIDER_UNAVAILABLE',
      );
      expect(s.meta.requests).toHaveLength(1);
    });

    it.each([
      ['another app', (st: FakeMetaSignupState) => (st.token.appId = '111111')],
      [
        'an invalid token',
        (st: FakeMetaSignupState) => (st.token.isValid = false),
      ],
      [
        'a missing messaging permission',
        (st: FakeMetaSignupState) =>
          (st.token.scopes = ['whatsapp_business_management']),
      ],
    ])('refuses a token for %s', async (_label, change) => {
      const state = defaultSignupState();
      change(state);
      const s = setup(connectOn, state);
      const { signupTicket } = await claimed(s);
      await expectCode(
        complete(s, signupTicket),
        'WHATSAPP_SIGNUP_TOKEN_UNVERIFIED',
      );
      expect(s.connectionRows.has(ORG)).toBe(false);
    });

    it('refuses an account the token does not grant', async () => {
      const s = setup();
      const { signupTicket } = await claimed(s);
      await expectCode(
        complete(s, signupTicket, { wabaIds: ['999999999999999'] }),
        'WHATSAPP_SIGNUP_ASSET_UNVERIFIED',
      );
      expect(s.connectionRows.has(ORG)).toBe(false);
    });

    it('refuses a number that is not on the granted account', async () => {
      const s = setup();
      const { signupTicket } = await claimed(s);
      await expectCode(
        complete(s, signupTicket, { phoneNumberId: '888888888888888' }),
        'WHATSAPP_SIGNUP_ASSET_UNVERIFIED',
      );
    });

    it('never picks among several accounts or numbers', async () => {
      const state = defaultSignupState();
      const second = '102290129340399';
      state.token.granularScopes = [
        {
          scope: 'whatsapp_business_management',
          target_ids: [FAKE_WABA_ID, second],
        },
        {
          scope: 'whatsapp_business_messaging',
          target_ids: [FAKE_WABA_ID, second],
        },
      ];
      state.phoneNumbersByWaba[FAKE_WABA_ID].push({
        id: '106540352242923',
        display_phone_number: '+20 100 555 0102',
      });
      const s = setup(connectOn, state);
      const first = await claimed(s);
      await expectCode(
        s.service.completeSignup({
          signupTicket: first.signupTicket,
          code: FAKE_CODE,
        }),
        'WHATSAPP_SIGNUP_ASSET_AMBIGUOUS',
      );

      state.validCodes.add(FAKE_CODE);
      const again = await claimed(s);
      await expectCode(
        s.service.completeSignup({
          signupTicket: again.signupTicket,
          code: FAKE_CODE,
          wabaIds: [FAKE_WABA_ID],
        }),
        'WHATSAPP_SIGNUP_ASSET_AMBIGUOUS',
      );
      expect(s.connectionRows.has(ORG)).toBe(false);
    });

    it('answers WHATSAPP_NUMBER_ALREADY_CONNECTED for a number another organization holds', async () => {
      const s = setup();
      s.connectionRows.set(OTHER_ORG, {
        state: 'active',
        phoneNumberId: FAKE_PHONE_NUMBER_ID,
      });
      const { signupTicket } = await claimed(s);
      await expectCode(
        complete(s, signupTicket),
        'WHATSAPP_NUMBER_ALREADY_CONNECTED',
      );
      expect(s.connectionRows.has(ORG)).toBe(false);
    });

    it('refuses a ticket from the link step', async () => {
      const s = setup();
      const issued = await s.service.issueTicket(owner(), 'ar');
      await expectCode(
        complete(s, new URL(issued.connectUrl).searchParams.get('ticket')!),
        'WHATSAPP_CONNECT_TICKET_INVALID',
      );
    });
  });
});
