import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readMetaGraphConfig } from '../../../../shared/config/meta-graph.config';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';

/**
 * The login code lives 30 seconds, so the exchange gets one bounded attempt.
 * It is never retried: a code may be single use, and a lost answer would
 * spend it.
 */
export const SIGNUP_CODE_EXCHANGE_TIMEOUT_MS = 10_000;
/** Reads are bounded too, so a completion answers well inside a minute. */
export const SIGNUP_GRAPH_READ_TIMEOUT_MS = 8_000;
/** A WhatsApp Business account holds a handful of numbers, never hundreds. */
export const WABA_PHONE_NUMBERS_PAGE_LIMIT = 100;

const META_ID = /^\d{1,32}$/;
const MAX_DISPLAY_PHONE_NUMBER_LENGTH = 32;

export type OwnNumberGraphFailureKind =
  /** Meta answered and refused: a bad code, a bad token, no access. */
  | 'rejected'
  /** No answer within the deadline. */
  | 'timeout'
  /** Network failure, a 5xx, or an answer that cannot be read. */
  | 'unavailable';

export interface OwnNumberGraphFailure {
  ok: false;
  kind: OwnNumberGraphFailureKind;
  /** Meta's numeric error code, when it gave one. Never its message. */
  graphErrorCode: number | null;
}

export type OwnNumberGraphResult<T> =
  | { ok: true; value: T }
  | OwnNumberGraphFailure;

/** What `debug_token` says about a business token, reduced to what is checked. */
export interface InspectedBusinessToken {
  appId: string | null;
  isValid: boolean;
  scopes: string[];
  /** Account ids per granted scope, newest first as Meta lists them. */
  granularScopes: { scope: string; targetIds: string[] }[];
}

export interface WabaPhoneNumber {
  id: string;
  displayPhoneNumber: string | null;
}

interface GraphErrorBody {
  error?: { code?: unknown; fbtrace_id?: unknown };
}

/**
 * Server-to-server Graph calls for Embedded Signup: exchange the login code,
 * inspect the resulting token, and read a WhatsApp Business account's numbers.
 *
 * Nothing here retries. Results are typed values; a provider body, token,
 * code or secret is never returned, thrown or logged. Request URLs are not
 * logged either, because the exchange carries the code and app secret in its
 * query, as Meta documents it.
 */
@Injectable()
export class OwnNumberGraphClient {
  private readonly logger = new Logger(OwnNumberGraphClient.name);
  private readonly graphBaseUrl: string;

  constructor(config: ConfigService) {
    this.graphBaseUrl = readMetaGraphConfig(config).baseUrl;
  }

  /** `GET /oauth/access_token`: the login code for a business token. */
  async exchangeCode(input: {
    appId: string;
    appSecret: string;
    code: string;
  }): Promise<OwnNumberGraphResult<{ businessToken: string }>> {
    const url = new URL(`${this.graphBaseUrl}/oauth/access_token`);
    url.searchParams.set('client_id', input.appId);
    url.searchParams.set('client_secret', input.appSecret);
    url.searchParams.set('code', input.code);
    const result = await this.getJson(
      'whatsapp_signup_code_exchange',
      url,
      undefined,
      SIGNUP_CODE_EXCHANGE_TIMEOUT_MS,
    );
    if (!result.ok) return result;
    const token = (result.value as { access_token?: unknown }).access_token;
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096)
      return this.malformed('whatsapp_signup_code_exchange');
    return { ok: true, value: { businessToken: token } };
  }

  /**
   * `GET /debug_token`, authorized with the app's own access token
   * (`app id|app secret`), so the answer is about the token, not about
   * whoever holds it.
   */
  async inspectToken(input: {
    appId: string;
    appSecret: string;
    businessToken: string;
  }): Promise<OwnNumberGraphResult<InspectedBusinessToken>> {
    const url = new URL(`${this.graphBaseUrl}/debug_token`);
    url.searchParams.set('input_token', input.businessToken);
    const result = await this.getJson(
      'whatsapp_signup_token_inspect',
      url,
      `${input.appId}|${input.appSecret}`,
      SIGNUP_GRAPH_READ_TIMEOUT_MS,
    );
    if (!result.ok) return result;
    const data = (result.value as { data?: unknown }).data;
    if (!data || typeof data !== 'object')
      return this.malformed('whatsapp_signup_token_inspect');
    const raw = data as {
      app_id?: unknown;
      is_valid?: unknown;
      scopes?: unknown;
      granular_scopes?: unknown;
    };
    return {
      ok: true,
      value: {
        appId:
          typeof raw.app_id === 'string' || typeof raw.app_id === 'number'
            ? String(raw.app_id)
            : null,
        isValid: raw.is_valid === true,
        scopes: Array.isArray(raw.scopes)
          ? raw.scopes.filter((s): s is string => typeof s === 'string')
          : [],
        granularScopes: Array.isArray(raw.granular_scopes)
          ? raw.granular_scopes.flatMap((entry: unknown) => {
              if (!entry || typeof entry !== 'object') return [];
              const { scope, target_ids } = entry as {
                scope?: unknown;
                target_ids?: unknown;
              };
              if (typeof scope !== 'string') return [];
              return [
                {
                  scope,
                  targetIds: Array.isArray(target_ids)
                    ? target_ids
                        .map((id: unknown) =>
                          typeof id === 'number' ? String(id) : id,
                        )
                        .filter(
                          (id): id is string =>
                            typeof id === 'string' && META_ID.test(id),
                        )
                    : [],
                },
              ];
            })
          : [],
      },
    };
  }

  /** `GET /{waba-id}/phone_numbers` with the business token: one bounded page. */
  async listWabaPhoneNumbers(input: {
    wabaId: string;
    businessToken: string;
  }): Promise<OwnNumberGraphResult<WabaPhoneNumber[]>> {
    if (!META_ID.test(input.wabaId))
      throw new Error('WhatsApp Business account id must be numeric');
    const url = new URL(`${this.graphBaseUrl}/${input.wabaId}/phone_numbers`);
    url.searchParams.set('fields', 'id,display_phone_number');
    url.searchParams.set('limit', String(WABA_PHONE_NUMBERS_PAGE_LIMIT));
    const result = await this.getJson(
      'whatsapp_signup_phone_numbers_read',
      url,
      input.businessToken,
      SIGNUP_GRAPH_READ_TIMEOUT_MS,
    );
    if (!result.ok) return result;
    const data = (result.value as { data?: unknown }).data;
    if (!Array.isArray(data))
      return this.malformed('whatsapp_signup_phone_numbers_read');
    return {
      ok: true,
      value: data.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== 'object') return [];
        const { id, display_phone_number } = entry as {
          id?: unknown;
          display_phone_number?: unknown;
        };
        if (typeof id !== 'string' || !META_ID.test(id)) return [];
        return [
          {
            id,
            displayPhoneNumber:
              typeof display_phone_number === 'string' &&
              display_phone_number.length > 0 &&
              display_phone_number.length <= MAX_DISPLAY_PHONE_NUMBER_LENGTH
                ? display_phone_number
                : null,
          },
        ];
      }),
    };
  }

  private async getJson(
    action: string,
    url: URL,
    bearer: string | undefined,
    timeoutMs: number,
  ): Promise<OwnNumberGraphResult<unknown>> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError');
      this.logger.warn(
        buildBackendLog(OwnNumberGraphClient.name, {
          action,
          outcome: 'failure',
          reason: timedOut ? 'timeout' : 'network',
          // Only the error's type: a fetch failure can quote the URL.
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return {
        ok: false,
        kind: timedOut ? 'timeout' : 'unavailable',
        graphErrorCode: null,
      };
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (body as GraphErrorBody | null)?.error;
      const graphErrorCode =
        typeof error?.code === 'number' ? error.code : null;
      this.logger.warn(
        buildBackendLog(OwnNumberGraphClient.name, {
          action,
          outcome: 'failure',
          httpStatus: response.status,
          graphErrorCode,
          fbtraceId:
            typeof error?.fbtrace_id === 'string' ? error.fbtrace_id : null,
        }),
      );
      return {
        ok: false,
        kind: response.status >= 500 ? 'unavailable' : 'rejected',
        graphErrorCode,
      };
    }
    if (!body || typeof body !== 'object') return this.malformed(action);
    this.logger.log(
      buildBackendLog(OwnNumberGraphClient.name, {
        action,
        outcome: 'success',
        httpStatus: response.status,
      }),
    );
    return { ok: true, value: body };
  }

  private malformed(action: string): OwnNumberGraphFailure {
    this.logger.warn(
      buildBackendLog(OwnNumberGraphClient.name, {
        action,
        outcome: 'failure',
        reason: 'unreadable_response',
      }),
    );
    return { ok: false, kind: 'unavailable', graphErrorCode: null };
  }
}
