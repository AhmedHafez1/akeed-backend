import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  META_GRAPH_CONFIG,
  parseMetaGraphConfig,
} from '../../../../shared/config/meta-graph.config';
import {
  FAKE_BUSINESS_TOKEN,
  FAKE_PHONE_NUMBER_ID,
  FAKE_WABA_ID,
} from '../../../../../test/contracts/meta-signup-fake';
import {
  createMetaSetupFake,
  defaultSetupState,
  FAKE_SETUP_APP_ID,
} from '../../../../../test/contracts/meta-own-number-setup-fake';
import { OwnNumberGraphClient } from './own-number-graph.client';

describe('OwnNumberGraphClient setup calls', () => {
  let logs: string[];

  function setup() {
    const meta = createMetaSetupFake(defaultSetupState());
    jest.spyOn(global, 'fetch').mockImplementation(meta.fetch as typeof fetch);
    const client = new OwnNumberGraphClient(
      new ConfigService({ [META_GRAPH_CONFIG]: parseMetaGraphConfig({}) }),
    );
    return { meta, client };
  }

  const token = { businessToken: FAKE_BUSINESS_TOKEN };

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

  it('reads the subscription, then subscribes with a POST and no body', async () => {
    const { meta, client } = setup();
    const read = { wabaId: FAKE_WABA_ID, appId: FAKE_SETUP_APP_ID, ...token };
    await expect(client.isAppSubscribed(read)).resolves.toEqual({
      ok: true,
      value: false,
    });
    await expect(
      client.subscribeApp({ wabaId: FAKE_WABA_ID, ...token }),
    ).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(client.isAppSubscribed(read)).resolves.toEqual({
      ok: true,
      value: true,
    });
    expect(meta.requests[1]).toMatchObject({
      method: 'POST',
      path: `/${FAKE_WABA_ID}/subscribed_apps`,
      body: undefined,
    });
  });

  it('reads the fields that tell Coexistence apart, and nulls what Meta leaves out', async () => {
    const { meta, client } = setup();
    meta.state.phones[FAKE_PHONE_NUMBER_ID] = { platform_type: 'CLOUD_API' };
    await expect(
      client.readPhoneNumber({ phoneNumberId: FAKE_PHONE_NUMBER_ID, ...token }),
    ).resolves.toEqual({
      ok: true,
      value: {
        id: FAKE_PHONE_NUMBER_ID,
        isOnBizApp: null,
        platformType: 'CLOUD_API',
        status: null,
      },
    });
    expect(meta.requests[0].query.fields).toContain('is_on_biz_app');
    expect(meta.requests[0].query.fields).toContain('platform_type');
  });

  it('reads a non-boolean is_on_biz_app as unknown', async () => {
    const { meta, client } = setup();
    meta.state.phones[FAKE_PHONE_NUMBER_ID] = {
      is_on_biz_app: 'true',
      platform_type: 'CLOUD_API',
    };
    const result = await client.readPhoneNumber({
      phoneNumberId: FAKE_PHONE_NUMBER_ID,
      ...token,
    });
    expect(result).toMatchObject({ ok: true, value: { isOnBizApp: null } });
  });

  it('registers with the documented body and never logs the PIN', async () => {
    const { meta, client } = setup();
    await expect(
      client.registerPhoneNumber({
        phoneNumberId: FAKE_PHONE_NUMBER_ID,
        pin: '048213',
        ...token,
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(meta.requests[0]).toMatchObject({
      method: 'POST',
      path: `/${FAKE_PHONE_NUMBER_ID}/register`,
      body: { messaging_product: 'whatsapp', pin: '048213' },
    });
    expect(logs.join('\n')).not.toContain('048213');
  });

  it('refuses a PIN that is not six digits before sending anything', async () => {
    const { meta, client } = setup();
    await expect(
      client.registerPhoneNumber({
        phoneNumberId: FAKE_PHONE_NUMBER_ID,
        pin: '12345',
        ...token,
      }),
    ).rejects.toThrow('six digits');
    expect(meta.requests).toHaveLength(0);
  });

  it('keeps the error subcode of a duplicate template and nothing of its message', async () => {
    const { meta, client } = setup();
    const body = {
      name: 'akeed_cod_verification_friendly',
      language: 'en',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hi' }],
    };
    await expect(
      client.createTemplate({ wabaId: FAKE_WABA_ID, body, ...token }),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: 'pending', category: 'utility' },
    });
    await expect(
      client.createTemplate({ wabaId: FAKE_WABA_ID, body, ...token }),
    ).resolves.toEqual({
      ok: false,
      kind: 'rejected',
      graphErrorCode: 100,
      graphErrorSubcode: 2388024,
    });
    expect(meta.requests).toHaveLength(2);
    expect(logs.join('\n')).not.toContain('Invalid request');
    expect(logs.join('\n')).not.toContain(FAKE_BUSINESS_TOKEN);
  });

  it('reads a create answer without an id as no answer', async () => {
    const { client } = setup();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'PENDING' }), { status: 200 }),
      );
    await expect(
      client.createTemplate({ wabaId: FAKE_WABA_ID, body: {}, ...token }),
    ).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
      graphErrorCode: null,
    });
  });

  it('refuses a non-numeric id before building a URL', async () => {
    const { meta, client } = setup();
    await expect(
      client.listTemplates({ wabaId: '../me', ...token }),
    ).rejects.toThrow('numeric');
    expect(meta.requests).toHaveLength(0);
  });
});
