import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
} from '../../../../../test/contracts/meta-signup-fake';
import { OwnNumberGraphClient } from './own-number-graph.client';

const SECRETS = [FAKE_APP_SECRET, FAKE_CODE, FAKE_BUSINESS_TOKEN];

describe('OwnNumberGraphClient', () => {
  let fetchSpy: jest.SpyInstance;
  let logs: string[];

  function setup(state = defaultSignupState()) {
    const fake = createMetaSignupFake(state);
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(fake.fetch as typeof fetch);
    const client = new OwnNumberGraphClient(
      new ConfigService({ META_GRAPH_API_VERSION: 'v26.0' }),
    );
    return { client, fake };
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const expectNoSecretsLogged = () => {
    for (const secret of SECRETS) expect(logs.join('\n')).not.toContain(secret);
  };

  it('exchanges the code once, at the versioned Graph URL, with no redirect URI', async () => {
    const { client, fake } = setup();
    const result = await client.exchangeCode({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
      code: FAKE_CODE,
    });
    expect(result).toEqual({
      ok: true,
      value: { businessToken: FAKE_BUSINESS_TOKEN },
    });
    expect(String((fetchSpy.mock.calls as unknown[][])[0][0])).toMatch(
      /^https:\/\/graph\.facebook\.com\/v26\.0\/oauth\/access_token\?/,
    );
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].query).not.toHaveProperty('redirect_uri');
    expectNoSecretsLogged();
  });

  it('reports a refused code with Meta’s number only, and never retries', async () => {
    const { client, fake } = setup();
    const result = await client.exchangeCode({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
      code: 'AQD-expired',
    });
    expect(result).toEqual({
      ok: false,
      kind: 'rejected',
      graphErrorCode: 100,
    });
    expect(fake.requests).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('AQD-expired');
    expectNoSecretsLogged();
  });

  it.each([
    [{ kind: 'network' } as const, 'unavailable'],
    [{ kind: 'server_error', httpStatus: 502 } as const, 'unavailable'],
    [{ kind: 'malformed' } as const, 'unavailable'],
  ])('maps %o to %s', async (failure, kind) => {
    const state = defaultSignupState();
    state.failures.exchange = failure;
    const { client, fake } = setup(state);
    const result = await client.exchangeCode({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
      code: FAKE_CODE,
    });
    expect(result).toMatchObject({ ok: false, kind });
    expect(fake.requests).toHaveLength(1);
    expectNoSecretsLogged();
  });

  it('gives up at its deadline', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const state = defaultSignupState();
      state.failures.exchange = { kind: 'timeout' };
      const { client } = setup(state);
      const timeout = jest
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms: number) => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), ms);
          return controller.signal;
        });
      const pending = client.exchangeCode({
        appId: FAKE_APP_ID,
        appSecret: FAKE_APP_SECRET,
        code: FAKE_CODE,
      });
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toEqual({
        ok: false,
        kind: 'timeout',
        graphErrorCode: null,
      });
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('inspects the token with the app token in the header, not the URL', async () => {
    const { client, fake } = setup();
    const result = await client.inspectToken({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
      businessToken: FAKE_BUSINESS_TOKEN,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        appId: FAKE_APP_ID,
        isValid: true,
        scopes: [
          'whatsapp_business_management',
          'whatsapp_business_messaging',
          'public_profile',
        ],
        granularScopes: [
          { scope: 'whatsapp_business_management', targetIds: [FAKE_WABA_ID] },
          { scope: 'whatsapp_business_messaging', targetIds: [FAKE_WABA_ID] },
        ],
      },
    });
    expect(fake.requests[0].query).not.toHaveProperty('access_token');
    expect(fake.requests[0].authorization).toBe(
      `Bearer ${FAKE_APP_ID}|${FAKE_APP_SECRET}`,
    );
    expectNoSecretsLogged();
  });

  it('drops target ids that are not Meta ids', async () => {
    const state = defaultSignupState();
    state.token.granularScopes = [
      {
        scope: 'whatsapp_business_management',
        target_ids: ['1', 'not-an-id', '../2'],
      },
    ];
    const { client } = setup(state);
    const result = await client.inspectToken({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
      businessToken: FAKE_BUSINESS_TOKEN,
    });
    expect(result.ok && result.value.granularScopes[0].targetIds).toEqual([
      '1',
    ]);
  });

  it('lists the account’s numbers with the business token', async () => {
    const { client, fake } = setup();
    const result = await client.listWabaPhoneNumbers({
      wabaId: FAKE_WABA_ID,
      businessToken: FAKE_BUSINESS_TOKEN,
    });
    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: FAKE_PHONE_NUMBER_ID,
          displayPhoneNumber: FAKE_DISPLAY_PHONE_NUMBER,
        },
      ],
    });
    expect(fake.requests[0]).toMatchObject({
      path: `/${FAKE_WABA_ID}/phone_numbers`,
      query: { fields: 'id,display_phone_number', limit: '100' },
    });
    expectNoSecretsLogged();
  });

  it('refuses to build a path from an id that is not numeric', async () => {
    const { client } = setup();
    await expect(
      client.listWabaPhoneNumbers({
        wabaId: '1/../me',
        businessToken: FAKE_BUSINESS_TOKEN,
      }),
    ).rejects.toThrow('numeric');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps a token echoed in an error out of the result and the logs', async () => {
    const state = defaultSignupState();
    state.failures.phone_numbers = {
      kind: 'meta_error',
      httpStatus: 400,
      code: 200,
    };
    const { client } = setup(state);
    const result = await client.listWabaPhoneNumbers({
      wabaId: FAKE_WABA_ID,
      businessToken: FAKE_BUSINESS_TOKEN,
    });
    expect(result).toEqual({
      ok: false,
      kind: 'rejected',
      graphErrorCode: 200,
    });
    expect(JSON.stringify(result)).not.toContain(FAKE_BUSINESS_TOKEN);
    expectNoSecretsLogged();
  });
});
