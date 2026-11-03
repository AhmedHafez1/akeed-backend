/**
 * An in-process Meta Graph for Embedded Signup: the code exchange, token
 * inspection and a WhatsApp Business account's phone numbers. It replaces
 * `fetch`, so no request leaves the process and no token it sees is real.
 *
 * Its answers follow Meta's documented shapes (checked 2026-11-02):
 *
 * - `GET /oauth/access_token?client_id&client_secret&code` answers
 *   `{ access_token, token_type: 'bearer' }`.
 * - `GET /debug_token?input_token=` answers `{ data: { app_id, is_valid,
 *   scopes, granular_scopes: [{ scope, target_ids }] } }`, newest account
 *   first.
 * - `GET /{waba-id}/phone_numbers` answers `{ data: [{ id,
 *   display_phone_number, ... }] }`.
 * - An error is `{ error: { message, type, code, fbtrace_id } }`. Its
 *   message echoes the code and token, the worst case for a logger.
 *
 * Where Meta is silent, the fake takes the worst case: a code is single use,
 * and a second exchange of the same code is refused.
 */

export const FAKE_APP_ID = '999653349077771';
export const FAKE_APP_SECRET = 'fake-app-secret-never-real';
export const FAKE_CODE = 'AQD-fake-login-code-never-real';
export const FAKE_BUSINESS_TOKEN = 'EAAG-fake-business-token-never-real';
export const FAKE_WABA_ID = '102290129340398';
export const FAKE_PHONE_NUMBER_ID = '106540352242922';
export const FAKE_DISPLAY_PHONE_NUMBER = '+20 100 555 0101';

export type FakeSignupFailure =
  | { kind: 'meta_error'; httpStatus: number; code: number }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'server_error'; httpStatus: number }
  | { kind: 'malformed' };

export interface FakeMetaSignupState {
  appId: string;
  validCodes: Set<string>;
  token: {
    appId: string;
    isValid: boolean;
    scopes: string[];
    granularScopes: { scope: string; target_ids: string[] }[];
  };
  phoneNumbersByWaba: Record<
    string,
    { id: string; display_phone_number: string }[]
  >;
  failures: Partial<
    Record<'exchange' | 'inspect' | 'phone_numbers', FakeSignupFailure>
  >;
}

export interface RecordedSignupRequest {
  path: string;
  query: Record<string, string>;
  authorization: string | null;
}

export function defaultSignupState(): FakeMetaSignupState {
  return {
    appId: FAKE_APP_ID,
    validCodes: new Set([FAKE_CODE]),
    token: {
      appId: FAKE_APP_ID,
      isValid: true,
      scopes: [
        'whatsapp_business_management',
        'whatsapp_business_messaging',
        'public_profile',
      ],
      granularScopes: [
        { scope: 'whatsapp_business_management', target_ids: [FAKE_WABA_ID] },
        { scope: 'whatsapp_business_messaging', target_ids: [FAKE_WABA_ID] },
      ],
    },
    phoneNumbersByWaba: {
      [FAKE_WABA_ID]: [
        {
          id: FAKE_PHONE_NUMBER_ID,
          display_phone_number: FAKE_DISPLAY_PHONE_NUMBER,
        },
      ],
    },
    failures: {},
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function metaError(httpStatus: number, code: number, echo: string): Response {
  return json(httpStatus, {
    error: {
      message: `Invalid request (${echo})`,
      type: 'OAuthException',
      code,
      fbtrace_id: 'AfakeTraceId',
    },
  });
}

/**
 * A `fetch` that answers like Meta. Requests are recorded so a test can check
 * what was sent, for example that nothing was retried.
 */
export function createMetaSignupFake(
  state: FakeMetaSignupState = defaultSignupState(),
) {
  const requests: RecordedSignupRequest[] = [];

  const fail = (
    failure: FakeSignupFailure,
    echo: string,
    signal?: AbortSignal | null,
  ): Promise<Response> => {
    switch (failure.kind) {
      case 'network':
        return Promise.reject(new TypeError(`fetch failed for ${echo}`));
      case 'timeout':
        // Never answers; the caller's deadline aborts it.
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () =>
            reject(
              Object.assign(new Error('The operation timed out.'), {
                name: 'TimeoutError',
              }),
            ),
          );
        });
      case 'server_error':
        return Promise.resolve(
          new Response('<html>upstream</html>', { status: failure.httpStatus }),
        );
      case 'malformed':
        return Promise.resolve(json(200, { unexpected: echo }));
      case 'meta_error':
        return Promise.resolve(
          metaError(failure.httpStatus, failure.code, echo),
        );
    }
  };

  const fetchImpl = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = new Headers(init?.headers);
    const segments = url.pathname.split('/').filter(Boolean).slice(1);
    const path = `/${segments.join('/')}`;
    requests.push({
      path,
      query: Object.fromEntries(url.searchParams),
      authorization: headers.get('authorization'),
    });

    if (path === '/oauth/access_token') {
      if (state.failures.exchange)
        return fail(state.failures.exchange, url.href, init?.signal);
      const code = url.searchParams.get('code') ?? '';
      if (
        url.searchParams.get('client_id') !== state.appId ||
        url.searchParams.get('client_secret') !== FAKE_APP_SECRET ||
        !state.validCodes.has(code)
      )
        return Promise.resolve(metaError(400, 100, code));
      state.validCodes.delete(code);
      return Promise.resolve(
        json(200, { access_token: FAKE_BUSINESS_TOKEN, token_type: 'bearer' }),
      );
    }

    if (path === '/debug_token') {
      if (state.failures.inspect)
        return fail(state.failures.inspect, url.href, init?.signal);
      if (
        headers.get('authorization') !==
        `Bearer ${state.appId}|${FAKE_APP_SECRET}`
      )
        return Promise.resolve(metaError(400, 190, url.href));
      if (url.searchParams.get('input_token') !== FAKE_BUSINESS_TOKEN)
        return Promise.resolve(
          json(200, { data: { is_valid: false, app_id: state.appId } }),
        );
      return Promise.resolve(
        json(200, {
          data: {
            app_id: state.token.appId,
            type: 'SYSTEM_USER',
            application: 'Akeed',
            is_valid: state.token.isValid,
            scopes: state.token.scopes,
            granular_scopes: state.token.granularScopes,
          },
        }),
      );
    }

    const phoneNumbers = /^\/(\d+)\/phone_numbers$/.exec(path);
    if (phoneNumbers) {
      if (state.failures.phone_numbers)
        return fail(state.failures.phone_numbers, url.href, init?.signal);
      if (headers.get('authorization') !== `Bearer ${FAKE_BUSINESS_TOKEN}`)
        return Promise.resolve(metaError(401, 190, FAKE_BUSINESS_TOKEN));
      const numbers = state.phoneNumbersByWaba[phoneNumbers[1]];
      if (!numbers) return Promise.resolve(metaError(400, 100, url.href));
      return Promise.resolve(
        json(200, {
          data: numbers.map((n) => ({
            ...n,
            verified_name: 'Fake Store',
            quality_rating: 'GREEN',
            code_verification_status: 'VERIFIED',
            platform_type: 'CLOUD_API',
          })),
          paging: { cursors: { before: 'a', after: 'b' } },
        }),
      );
    }

    return Promise.resolve(metaError(404, 803, url.href));
  };

  return { fetch: fetchImpl, requests, state };
}
