import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readMetaGraphConfig } from '../../../../shared/config/meta-graph.config';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';
import type {
  ProviderTemplateRecord,
  TemplateCategory,
  TemplateReviewStatus,
} from '../../../../shared/messaging/template-provider.types';
import {
  META_TEMPLATE_FIELDS,
  META_TEMPLATE_MAX_PAGES,
  META_TEMPLATE_PAGE_SIZE,
  toRecord,
  type MetaTemplateNode,
} from '../meta-template-catalog.adapter';
import { mapApiStatus, mapCategory } from '../meta-template.mapping';
import type { SenderHealthResult } from '../../../../shared/ports/sender-recovery.port';
import { classifyOwnNumberFailure } from './own-number-send-failure.policy';

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

/** Setup runs in a background job, so a slower answer is acceptable. */
export const SETUP_GRAPH_TIMEOUT_MS = 15_000;

const META_ID = /^\d{1,32}$/;
const MAX_DISPLAY_PHONE_NUMBER_LENGTH = 32;
const PROVIDER_ENUM = /^[A-Z_]{1,32}$/;

function assertMetaId(id: string): string {
  if (!META_ID.test(id)) throw new Error('Meta id must be numeric');
  return id;
}

/** An upper-case provider value such as `CLOUD_API`, or null. */
function providerEnum(value: unknown): string | null {
  return typeof value === 'string' && PROVIDER_ENUM.test(value) ? value : null;
}

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
  /** Meta's `error_subcode`, present only when it sent one. */
  graphErrorSubcode?: number;
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

/** How Meta reports a number's use. Null where Meta sent nothing usable. */
export interface PhoneNumberStatus {
  id: string;
  /** Also used in the WhatsApp Business app (Coexistence). */
  isOnBizApp: boolean | null;
  /** `CLOUD_API` once the number is on Cloud API. */
  platformType: string | null;
  status: string | null;
}

interface GraphErrorBody {
  error?: { code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown };
}

/**
 * Server-to-server Graph calls for a merchant's own number. Signup exchanges
 * the login code, inspects the token and reads the account's numbers; setup
 * subscribes the app to the account, reads the number and registers it.
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

  async readHealth(
    phoneNumberId: string,
    businessToken: string,
  ): Promise<SenderHealthResult> {
    const url = new URL(`${this.graphBaseUrl}/${assertMetaId(phoneNumberId)}`);
    url.searchParams.set(
      'fields',
      'id,health_status,quality_rating,name_status',
    );
    const result = await this.getJson(
      'whatsapp_connection_health',
      url,
      businessToken,
      SIGNUP_GRAPH_READ_TIMEOUT_MS,
    );
    if (!result.ok)
      return {
        status: result.kind === 'rejected' ? 'BLOCKED' : 'unknown',
        ...(result.kind === 'rejected'
          ? {
              failure: classifyOwnNumberFailure({
                code: result.graphErrorCode,
              }),
            }
          : {}),
      };
    const raw = result.value as {
      id?: unknown;
      health_status?: {
        can_send_message?: unknown;
        entities?: { errors?: { error_code?: unknown }[] }[];
      };
      quality_rating?: unknown;
      name_status?: unknown;
    };
    if (String(raw.id) !== phoneNumberId) return { status: 'unknown' };
    const status = raw.health_status?.can_send_message;
    if (status !== 'AVAILABLE' && status !== 'LIMITED' && status !== 'BLOCKED')
      return { status: 'unknown' };
    const failures = (raw.health_status?.entities ?? [])
      .flatMap((entity) => entity.errors ?? [])
      .map((error) => classifyOwnNumberFailure({ code: error.error_code }));
    const failure =
      failures.find((item) => item.class === 'credentials') ??
      failures.find((item) => item.class === 'payment') ??
      failures.find((item) => item.class === 'restricted');
    return {
      status,
      ...(failure ? { failure } : {}),
      qualityRating: providerEnum(raw.quality_rating),
      nameStatus: providerEnum(raw.name_status),
    };
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

  /**
   * `GET /{waba-id}/subscribed_apps`: whether this app already receives the
   * account's webhooks. Meta lists each app as `whatsapp_business_api_data`.
   */
  async isAppSubscribed(input: {
    wabaId: string;
    appId: string;
    businessToken: string;
  }): Promise<OwnNumberGraphResult<boolean>> {
    const url = new URL(
      `${this.graphBaseUrl}/${assertMetaId(input.wabaId)}/subscribed_apps`,
    );
    const result = await this.getJson(
      'whatsapp_setup_subscription_read',
      url,
      input.businessToken,
      SETUP_GRAPH_TIMEOUT_MS,
    );
    if (!result.ok) return result;
    const data = (result.value as { data?: unknown }).data;
    if (!Array.isArray(data))
      return this.malformed('whatsapp_setup_subscription_read');
    return {
      ok: true,
      value: data.some((entry: unknown) => {
        const app = (
          entry as { whatsapp_business_api_data?: { id?: unknown } } | null
        )?.whatsapp_business_api_data;
        const id = app?.id;
        return (
          (typeof id === 'string' || typeof id === 'number') &&
          String(id) === input.appId
        );
      }),
    };
  }

  /** `POST /{waba-id}/subscribed_apps`: Meta answers `{ success: true }`. */
  async subscribeApp(input: {
    wabaId: string;
    businessToken: string;
  }): Promise<OwnNumberGraphResult<void>> {
    const url = new URL(
      `${this.graphBaseUrl}/${assertMetaId(input.wabaId)}/subscribed_apps`,
    );
    const result = await this.requestJson(
      'whatsapp_setup_subscribe',
      'POST',
      url,
      input.businessToken,
      SETUP_GRAPH_TIMEOUT_MS,
    );
    if (!result.ok) return result;
    if ((result.value as { success?: unknown }).success !== true)
      return this.malformed('whatsapp_setup_subscribe');
    return { ok: true, value: undefined };
  }

  async unsubscribeApp(input: {
    wabaId: string;
    businessToken: string;
  }): Promise<OwnNumberGraphResult<void>> {
    const result = await this.requestJson(
      'whatsapp_disconnect_unsubscribe',
      'DELETE',
      new URL(
        `${this.graphBaseUrl}/${assertMetaId(input.wabaId)}/subscribed_apps`,
      ),
      input.businessToken,
      SETUP_GRAPH_TIMEOUT_MS,
    );
    if (!result.ok) return result;
    return (result.value as { success?: unknown }).success === true
      ? { ok: true, value: undefined }
      : this.malformed('whatsapp_disconnect_unsubscribe');
  }

  /**
   * `GET /{phone-number-id}` with the fields that tell how the number is used.
   * Meta documents `is_on_biz_app` and `platform_type` together for
   * Coexistence; a field it leaves out is null here, never guessed.
   */
  async readPhoneNumber(input: {
    phoneNumberId: string;
    businessToken: string;
  }): Promise<OwnNumberGraphResult<PhoneNumberStatus>> {
    const url = new URL(
      `${this.graphBaseUrl}/${assertMetaId(input.phoneNumberId)}`,
    );
    url.searchParams.set(
      'fields',
      'id,display_phone_number,is_on_biz_app,platform_type,status,code_verification_status',
    );
    const result = await this.getJson(
      'whatsapp_setup_phone_number_read',
      url,
      input.businessToken,
      SETUP_GRAPH_TIMEOUT_MS,
    );
    if (!result.ok) return result;
    const raw = result.value as {
      id?: unknown;
      is_on_biz_app?: unknown;
      platform_type?: unknown;
      status?: unknown;
    };
    if (raw.id !== input.phoneNumberId)
      return this.malformed('whatsapp_setup_phone_number_read');
    return {
      ok: true,
      value: {
        id: input.phoneNumberId,
        isOnBizApp:
          typeof raw.is_on_biz_app === 'boolean' ? raw.is_on_biz_app : null,
        platformType: providerEnum(raw.platform_type),
        status: providerEnum(raw.status),
      },
    };
  }

  /**
   * `POST /{phone-number-id}/register` with the two-step PIN. Meta limits this
   * to 10 requests per number in 72 hours, so it is called once per attempt
   * and never retried here. The body holds the PIN and is never logged.
   */
  async registerPhoneNumber(input: {
    phoneNumberId: string;
    businessToken: string;
    pin: string;
  }): Promise<OwnNumberGraphResult<void>> {
    if (!/^\d{6}$/.test(input.pin))
      throw new Error('Registration PIN must be six digits');
    const url = new URL(
      `${this.graphBaseUrl}/${assertMetaId(input.phoneNumberId)}/register`,
    );
    const result = await this.requestJson(
      'whatsapp_setup_register',
      'POST',
      url,
      input.businessToken,
      SETUP_GRAPH_TIMEOUT_MS,
      { messaging_product: 'whatsapp', pin: input.pin },
    );
    if (!result.ok) return result;
    if ((result.value as { success?: unknown }).success !== true)
      return this.malformed('whatsapp_setup_register');
    return { ok: true, value: undefined };
  }

  /**
   * `GET /{waba-id}/message_templates`, every page. Pages follow
   * `paging.cursors.after`; `paging.next` is read only as "there is more",
   * because it is a full URL. Nothing is returned until every page is read,
   * so a failure part-way gives no partial list.
   */
  async listTemplates(input: {
    wabaId: string;
    businessToken: string;
  }): Promise<OwnNumberGraphResult<ProviderTemplateRecord[]>> {
    const records: ProviderTemplateRecord[] = [];
    let after: string | undefined;
    for (let page = 1; page <= META_TEMPLATE_MAX_PAGES; page += 1) {
      const url = new URL(
        `${this.graphBaseUrl}/${assertMetaId(input.wabaId)}/message_templates`,
      );
      url.searchParams.set('fields', META_TEMPLATE_FIELDS);
      url.searchParams.set('limit', String(META_TEMPLATE_PAGE_SIZE));
      if (after) url.searchParams.set('after', after);
      const result = await this.getJson(
        'whatsapp_setup_templates_read',
        url,
        input.businessToken,
        SETUP_GRAPH_TIMEOUT_MS,
      );
      if (!result.ok) return result;
      const body = result.value as {
        data?: unknown;
        paging?: { cursors?: { after?: unknown }; next?: unknown };
      };
      if (!Array.isArray(body.data))
        return this.malformed('whatsapp_setup_templates_read');
      for (const node of body.data as MetaTemplateNode[]) {
        const record = node && typeof node === 'object' ? toRecord(node) : null;
        if (record) records.push(record);
      }
      const cursor = body.paging?.cursors?.after;
      if (!body.paging?.next || typeof cursor !== 'string' || !cursor)
        return { ok: true, value: records };
      after = cursor;
    }
    this.logger.warn(
      buildBackendLog(OwnNumberGraphClient.name, {
        action: 'whatsapp_setup_templates_read',
        outcome: 'failure',
        reason: 'too_many_pages',
      }),
    );
    return { ok: false, kind: 'unavailable', graphErrorCode: null };
  }

  /**
   * `POST /{waba-id}/message_templates`, sent once. A refusal keeps Meta's
   * code and subcode so the caller can tell a duplicate (`100`/`2388024`)
   * from a rejection; no answer is `timeout` or `unavailable`, and the
   * template may then exist.
   */
  async createTemplate(input: {
    wabaId: string;
    businessToken: string;
    body: Record<string, unknown>;
  }): Promise<
    OwnNumberGraphResult<{
      providerTemplateId: string;
      status: TemplateReviewStatus;
      category: TemplateCategory;
    }>
  > {
    const url = new URL(
      `${this.graphBaseUrl}/${assertMetaId(input.wabaId)}/message_templates`,
    );
    const result = await this.requestJson(
      'whatsapp_setup_template_create',
      'POST',
      url,
      input.businessToken,
      SETUP_GRAPH_TIMEOUT_MS,
      input.body,
    );
    if (!result.ok) return result;
    const raw = result.value as {
      id?: unknown;
      status?: unknown;
      category?: unknown;
    };
    const id =
      typeof raw.id === 'string' || typeof raw.id === 'number'
        ? String(raw.id)
        : null;
    // An answer without an id is not proof of a template either way.
    if (!id || !META_ID.test(id))
      return this.malformed('whatsapp_setup_template_create');
    return {
      ok: true,
      value: {
        providerTemplateId: id,
        status: mapApiStatus(raw.status),
        category: mapCategory(raw.category),
      },
    };
  }

  private getJson(
    action: string,
    url: URL,
    bearer: string | undefined,
    timeoutMs: number,
  ): Promise<OwnNumberGraphResult<unknown>> {
    return this.requestJson(action, 'GET', url, bearer, timeoutMs);
  }

  private async requestJson(
    action: string,
    method: 'GET' | 'POST' | 'DELETE',
    url: URL,
    bearer: string | undefined,
    timeoutMs: number,
    jsonBody?: unknown,
  ): Promise<OwnNumberGraphResult<unknown>> {
    let response: Response;
    try {
      const headers: Record<string, string> = {};
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (jsonBody !== undefined) headers['Content-Type'] = 'application/json';
      response = await fetch(url, {
        method,
        headers,
        ...(jsonBody !== undefined && { body: JSON.stringify(jsonBody) }),
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
      const graphErrorSubcode =
        typeof error?.error_subcode === 'number' ? error.error_subcode : null;
      this.logger.warn(
        buildBackendLog(OwnNumberGraphClient.name, {
          action,
          outcome: 'failure',
          httpStatus: response.status,
          graphErrorCode,
          ...(graphErrorSubcode !== null && { graphErrorSubcode }),
          fbtraceId:
            typeof error?.fbtrace_id === 'string' ? error.fbtrace_id : null,
        }),
      );
      return {
        ok: false,
        kind: response.status >= 500 ? 'unavailable' : 'rejected',
        graphErrorCode,
        ...(graphErrorSubcode !== null && { graphErrorSubcode }),
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
