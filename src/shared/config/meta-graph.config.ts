export const META_GRAPH_CONFIG = 'metaGraph';

export const DEFAULT_META_GRAPH_API_VERSION = 'v26.0';

/** The one Graph version every Meta call in the app uses. */
export interface MetaGraphConfig {
  apiVersion: string;
  baseUrl: string;
}

export function parseMetaGraphConfig(
  config: Record<string, unknown>,
): MetaGraphConfig {
  const raw = config.META_GRAPH_API_VERSION;
  const value = typeof raw === 'string' ? raw.trim() : '';
  const apiVersion = value.length > 0 ? value : DEFAULT_META_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new Error(
      'Invalid environment configuration:\n - META_GRAPH_API_VERSION must look like v26.0.',
    );
  }
  return {
    apiVersion,
    baseUrl: `https://graph.facebook.com/${apiVersion}`,
  };
}

export function readMetaGraphConfig(config: {
  get<T>(key: string): T | undefined;
}): MetaGraphConfig {
  return (
    config.get<MetaGraphConfig>(META_GRAPH_CONFIG) ?? parseMetaGraphConfig({})
  );
}
