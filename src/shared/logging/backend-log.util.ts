type LogOutcome = 'success' | 'failure' | 'retry' | 'skipped';

interface BackendLogContext {
  action: string;
  outcome: LogOutcome;
  requestId?: string;
  orgId?: string;
  shopDomain?: string;
  userId?: string;
  jobId?: string;
  durationMs?: number;
  httpStatus?: number;
  errorCode?: string;
  [key: string]: unknown;
}

interface NormalizedError {
  errorName?: string;
  errorMessage?: string;
  stack?: string;
}

const REDACTED_VALUE = '[REDACTED]';
const REDACTED_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'jwt',
  'password',
  'passcode',
  'otp',
  'secret',
  'client_secret',
  'clientsecret',
  'api_key',
  'apikey',
  'hmac',
  'signature',
  'wa_access_token',
  'shopify_api_secret',
  'supabase_anon_key',
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }

  if (value !== null && typeof value === 'object') {
    const redactedEntries = Object.entries(
      value as Record<string, unknown>,
    ).map(([key, entry]) => {
      if (REDACTED_KEYS.has(key.toLowerCase())) {
        return [key, REDACTED_VALUE] as const;
      }

      return [key, redact(entry)] as const;
    });

    return Object.fromEntries(redactedEntries);
  }

  return value;
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
    };
  }

  if (typeof error === 'string') {
    return { errorMessage: error };
  }

  return { errorMessage: 'Unknown error' };
}

export function buildBackendLog(
  moduleName: string,
  context: BackendLogContext,
): string {
  const redactedContext = redact(context);
  const safeContext =
    redactedContext !== null && typeof redactedContext === 'object'
      ? (redactedContext as Record<string, unknown>)
      : {};

  const payload: Record<string, unknown> = {
    app: 'backend',
    env: process.env.NODE_ENV ?? 'development',
    module: moduleName,
    ...safeContext,
  };

  return JSON.stringify(payload);
}
