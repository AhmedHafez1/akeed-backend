import { validateEnv } from './env-validation';

const meta = {
  WA_ACCESS_TOKEN: 'token',
  WA_PHONE_NUMBER_ID: 'phone',
  WA_VERIFY_TOKEN: 'verify',
  META_APP_SECRET: 'a-real-secret',
};

describe('validateEnv', () => {
  it('accepts a fully configured environment', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/db',
        ...meta,
      }),
    ).not.toThrow();
  });

  it('names every missing Meta variable rather than failing on the first', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://localhost/db',
      }),
    ).toThrow(/WA_ACCESS_TOKEN[\s\S]*META_APP_SECRET/);
  });

  it('rejects the .env.example placeholder secret outside development', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/db',
        ...meta,
        META_APP_SECRET: '07d18791af2d3a95ee5086da1d86bcbc',
      }),
    ).toThrow(/META_APP_SECRET is still set to the/);
  });

  it('tolerates the placeholder locally so a fresh checkout still boots', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://localhost/db',
        ...meta,
        META_APP_SECRET: '07d18791af2d3a95ee5086da1d86bcbc',
      }),
    ).not.toThrow();
  });

  it('does not demand Meta credentials from the test environment', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x/db' }),
    ).not.toThrow();
  });

  it('still requires DATABASE_URL everywhere', () => {
    expect(() => validateEnv({ NODE_ENV: 'test' })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  it('treats a whitespace-only value as missing', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://x/db',
        ...meta,
        WA_VERIFY_TOKEN: '   ',
      }),
    ).toThrow(/WA_VERIFY_TOKEN is required/);
  });
});
