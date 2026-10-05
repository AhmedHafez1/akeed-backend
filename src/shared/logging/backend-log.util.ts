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
  // Integration API keys (US-05-01): the stored hash and the full key.
  'key_hash',
  'keyhash',
  'plaintext',
  // EasyOrders install (US-06-02): the one-time callback token, the webhook
  // URL token, the seller-copied webhook secrets and the link carrying both
  // tokens.
  'callback_token',
  'callbacktoken',
  'webhook_token',
  'webhooktoken',
  'webhook_secret',
  'webhooksecret',
  'orderssecret',
  'statussecret',
  'install_url',
  'installurl',
  // WooCommerce install (US-07-02): the keys the store posts to the callback
  // and the authorize link, which carries the one-time callback token.
  'consumer_key',
  'consumerkey',
  'consumer_secret',
  'consumersecret',
  'authorize_url',
  'authorizeurl',
  'client_secret',
  'clientsecret',
  'api_key',
  'apikey',
  'hmac',
  'signature',
  'wa_access_token',
  'shopify_api_secret',
  'supabase_anon_key',
  // A hosted-checkout URL carries the provider client secret in its query, so
  // the whole URL is a credential rather than a location.
  'checkout_url',
  'checkouturl',
  'public_key',
  'publickey',
  // Card metadata a payment callback carries. Masked by the provider, but
  // still cardholder data we have no reason to write down.
  'pan',
  'source_data',
  'card_number',
  'cardnumber',
  'wallet_number',
  'walletnumber',
  'wallet_token',
  'wallettoken',
  'msisdn',
  // A merchant's upload name often carries a customer or store name, and a
  // file's cells are customer data (E04.6 bulk import).
  'filename',
  'file_name',
  'originalname',
  'cells',
  'raw',
  // Paymob credentials by the names its configuration uses.
  'secret_key',
  'secretkey',
  'hmac_secret',
  'hmacsecret',
  'private_key',
  'privatekey',
  // Settlement evidence and raw customer/provider material are retained only
  // in their purpose-built stores. They must never leak into Railway logs.
  'evidence',
  'raw_payload',
  'rawpayload',
  'phone',
  'customer_phone',
  'customerphone',
  'email',
  'customer_email',
  'customeremail',
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

interface FailedQueryError extends Error {
  query: string;
  params: unknown[];
}

function isFailedQuery(error: Error): error is FailedQueryError {
  const candidate = error as Partial<FailedQueryError>;
  return typeof candidate.query === 'string' && Array.isArray(candidate.params);
}

/**
 * Drizzle reports a failed statement as "Failed query: <sql>" followed by
 * "params: <values>", and the values are row data: phones, names, token
 * hashes, ciphertexts. This is the same failure without them: the SQL text,
 * which holds placeholders only, and the driver's own code and message.
 * `detail` and `where` are left out because they can carry row values.
 *
 * Any other error is returned as it is.
 */
export function withoutQueryParameters(error: Error): Error {
  if (!isFailedQuery(error)) return error;
  const cause = error.cause as
    | { code?: unknown; message?: unknown }
    | null
    | undefined;
  const code = typeof cause?.code === 'string' ? `${cause.code} ` : '';
  const reason =
    typeof cause?.message === 'string'
      ? `\n  cause: ${code}${cause.message}`
      : '';
  const safe = new Error(`Failed query: ${error.query}${reason}`);
  safe.name = error.name;
  // The original stack begins with its message, parameters included: only
  // the frames after it are kept.
  const stack = error.stack ?? '';
  const messageAt = stack.indexOf(error.message);
  const frames =
    messageAt < 0 ? '' : stack.slice(messageAt + error.message.length);
  safe.stack = `${safe.name}: ${safe.message}${frames}`;
  return safe;
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    const safe = withoutQueryParameters(error);
    return {
      errorName: safe.name,
      errorMessage: safe.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : safe.stack,
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
