import {
  DEFAULT_META_GRAPH_API_VERSION,
  META_GRAPH_CONFIG,
  parseMetaGraphConfig,
  readMetaGraphConfig,
} from './meta-graph.config';
import { validateEnv } from './env-validation';

describe('meta graph config', () => {
  it('defaults to v26.0 when the setting is absent or blank', () => {
    expect(DEFAULT_META_GRAPH_API_VERSION).toBe('v26.0');
    expect(parseMetaGraphConfig({})).toEqual({
      apiVersion: 'v26.0',
      baseUrl: 'https://graph.facebook.com/v26.0',
    });
    expect(
      parseMetaGraphConfig({ META_GRAPH_API_VERSION: '  ' }).apiVersion,
    ).toBe('v26.0');
  });

  it('uses a configured version', () => {
    expect(
      parseMetaGraphConfig({ META_GRAPH_API_VERSION: ' v27.0 ' }).baseUrl,
    ).toBe('https://graph.facebook.com/v27.0');
  });

  it.each(['26.0', 'v26', 'v26.0/', 'latest', 'v26.0/../me'])(
    'refuses %s',
    (value) => {
      expect(() =>
        parseMetaGraphConfig({ META_GRAPH_API_VERSION: value }),
      ).toThrow('META_GRAPH_API_VERSION');
    },
  );

  it('fails at boot on a malformed value', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://db',
        META_GRAPH_API_VERSION: 'latest',
      }),
    ).toThrow('META_GRAPH_API_VERSION');
  });

  it('reaches consumers through validateEnv', () => {
    const validated = validateEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://db',
      META_GRAPH_API_VERSION: 'v27.0',
    });
    expect(validated[META_GRAPH_CONFIG]).toMatchObject({
      apiVersion: 'v27.0',
    });
  });

  it('falls back to the default where no validated config exists', () => {
    expect(readMetaGraphConfig({ get: () => undefined }).apiVersion).toBe(
      'v26.0',
    );
  });
});
