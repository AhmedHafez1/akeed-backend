import {
  ORDER_API_CONFIG,
  parseOrderApiConfig,
  readOrderApiConfig,
} from './order-api.config';

describe('order API configuration', () => {
  it('uses the pilot defaults when nothing is set', () => {
    expect(parseOrderApiConfig({})).toEqual({
      perIntegrationPerMinute: 60,
      globalPerMinute: 300,
      preAuthPerIpPerMinute: 600,
      maxBodyBytes: 32 * 1024,
    });
  });

  it('reads every limit from the environment', () => {
    expect(
      parseOrderApiConfig({
        ORDER_API_RATE_LIMIT_PER_INTEGRATION: ' 10 ',
        ORDER_API_RATE_LIMIT_GLOBAL: '20',
        ORDER_API_RATE_LIMIT_PRE_AUTH_PER_IP: '30',
        ORDER_API_MAX_BODY_BYTES: '2048',
      }),
    ).toEqual({
      perIntegrationPerMinute: 10,
      globalPerMinute: 20,
      preAuthPerIpPerMinute: 30,
      maxBodyBytes: 2048,
    });
  });

  it.each([
    ['ORDER_API_RATE_LIMIT_PER_INTEGRATION', '0'],
    ['ORDER_API_RATE_LIMIT_PER_INTEGRATION', '6001'],
    ['ORDER_API_RATE_LIMIT_PER_INTEGRATION', '1.5'],
    ['ORDER_API_RATE_LIMIT_GLOBAL', 'many'],
    ['ORDER_API_RATE_LIMIT_GLOBAL', '-1'],
    ['ORDER_API_RATE_LIMIT_PRE_AUTH_PER_IP', '0'],
    ['ORDER_API_MAX_BODY_BYTES', '1023'],
    ['ORDER_API_MAX_BODY_BYTES', '102401'],
  ])('fails boot when %s is %s', (key, value) => {
    expect(() => parseOrderApiConfig({ [key]: value })).toThrow(
      new RegExp(`${key} must be an integer from`),
    );
  });

  it('fails boot when one integration is allowed more than everyone together', () => {
    expect(() =>
      parseOrderApiConfig({
        ORDER_API_RATE_LIMIT_PER_INTEGRATION: '400',
        ORDER_API_RATE_LIMIT_GLOBAL: '300',
      }),
    ).toThrow(
      /ORDER_API_RATE_LIMIT_PER_INTEGRATION must not exceed ORDER_API_RATE_LIMIT_GLOBAL/,
    );
  });

  it('fails boot when the pre-auth ceiling is below the global limit', () => {
    expect(() =>
      parseOrderApiConfig({ ORDER_API_RATE_LIMIT_PRE_AUTH_PER_IP: '100' }),
    ).toThrow(
      /ORDER_API_RATE_LIMIT_GLOBAL must not exceed ORDER_API_RATE_LIMIT_PRE_AUTH_PER_IP/,
    );
  });

  it('reads back the validated object and refuses an unvalidated config', () => {
    const parsed = parseOrderApiConfig({});
    const values: Record<string, unknown> = { [ORDER_API_CONFIG]: parsed };
    expect(
      readOrderApiConfig({ get: <T>(key: string) => values[key] as T }),
    ).toBe(parsed);
    expect(() => readOrderApiConfig({ get: () => undefined })).toThrow(
      'Order API configuration was not validated',
    );
  });
});
