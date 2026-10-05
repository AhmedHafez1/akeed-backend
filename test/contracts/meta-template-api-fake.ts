import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { Observable } from 'rxjs';

/**
 * An in-process Meta Graph `message_templates` list for the E08 suites. No
 * request leaves the process, and no token it sees is a real one.
 *
 * Its behavior comes only from the US-08-01 contract record. Where the record
 * is silent the fake takes the record's worst case and says which:
 *
 * - The list answers `data`, `paging.cursors.after` and `paging.next`
 *   (4.1.1). `paging.next` is a full URL that echoes the token, so an adapter
 *   that followed or logged it would leak it (record 1.4).
 * - `components` uses the creation syntax (S2, 4.7.5) and `quality_score` a
 *   bare documented string. Neither shape is documented for the list
 *   response, so both are "documented shape, not captured", like the webhook
 *   fixtures.
 * - An error body is `{ error: { message, type, code, fbtrace_id } }`
 *   (4.1.10). Its message echoes the token, the worst case for a logger.
 * - Rate limits answer the codes in 4.9.4; the HTTP status that comes with
 *   them is not documented, so the fake uses 400.
 */

export const FAKE_ACCOUNT_ID = '100000000000001';
export const FAKE_TOKEN = 'EAAG-fake-template-token-never-real';

export interface FakeMetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  correct_category?: string;
  quality_score?: unknown;
  components?: unknown;
}

export type FakeMetaFailure =
  | { kind: 'meta_error'; httpStatus: number; code: number }
  | { kind: 'network' }
  | { kind: 'server_error'; httpStatus: number };

/** A COD confirmation in creation syntax, with synthetic text. */
export function codComponents(body: string): unknown[] {
  return [
    { type: 'BODY', text: body },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Synthetic confirm' },
        { type: 'QUICK_REPLY', text: 'Synthetic cancel' },
      ],
    },
  ];
}

/** The 8 Akeed templates as an approved, healthy account would list them. */
export function akeedTemplates(): FakeMetaTemplate[] {
  const names: [string, string][] = [
    ['akeed_cod_verification_friendly', 'ar'],
    ['akeed_cod_verification_direct_eg', 'ar_EG'],
    ['akeed_cod_verification_direct_gulf', 'ar'],
    ['akeed_cod_verification', 'ar'],
    ['akeed_cod_verification_friendly', 'en'],
    ['_akeed_cod_verification_professional', 'en'],
    ['akeed_cod_verification_direct_', 'en'],
    ['akeed_cod_verification', 'en'],
  ];
  return names.map(([name, language], index) => ({
    id: String(900000000000001 + index),
    name,
    language,
    status: 'APPROVED',
    category: 'UTILITY',
    quality_score: 'GREEN',
    components: codComponents(`Synthetic body ${index + 1} {{1}}`),
  }));
}

export interface FakeMetaTemplateRequest {
  url: string;
  authorization: string | undefined;
  params: Record<string, unknown>;
}

export class FakeMetaTemplateApi {
  templates: FakeMetaTemplate[];
  pageSize: number;
  readonly requests: FakeMetaTemplateRequest[] = [];
  /** Failures to answer, by 1-based page number. */
  private readonly failures = new Map<number, FakeMetaFailure>();

  constructor(
    options: { templates?: FakeMetaTemplate[]; pageSize?: number } = {},
  ) {
    this.templates = options.templates ?? akeedTemplates();
    this.pageSize = options.pageSize ?? 100;
  }

  failOnPage(page: number, failure: FakeMetaFailure): this {
    this.failures.set(page, failure);
    return this;
  }

  clearFailures(): this {
    this.failures.clear();
    return this;
  }

  /** Stands in for `HttpService` in the adapter. */
  get httpService(): {
    get: (url: string, config?: unknown) => Observable<AxiosResponse>;
  } {
    return { get: (url, config) => this.get(url, config) };
  }

  private get(url: string, config: unknown): Observable<AxiosResponse> {
    return new Observable((subscriber) => {
      const options = (config ?? {}) as {
        headers?: Record<string, string>;
        params?: Record<string, unknown>;
      };
      const params = options.params ?? {};
      this.requests.push({
        url,
        authorization: options.headers?.Authorization,
        params,
      });
      const page = this.requests.length;
      const failure = this.failures.get(page);
      if (failure) {
        subscriber.error(this.error(url, failure));
        return;
      }
      if (
        !url.endsWith(`/${FAKE_ACCOUNT_ID}/message_templates`) ||
        options.headers?.Authorization !== `Bearer ${FAKE_TOKEN}`
      ) {
        subscriber.error(
          this.error(url, { kind: 'meta_error', httpStatus: 401, code: 190 }),
        );
        return;
      }
      const limit = Number(params.limit ?? 25);
      const start = typeof params.after === 'string' ? Number(params.after) : 0;
      const slice = this.templates.slice(
        start,
        start + Math.min(limit, this.pageSize),
      );
      const end = start + slice.length;
      const more = end < this.templates.length;
      subscriber.next(
        this.response(url, 200, {
          data: slice,
          paging: {
            cursors: { before: String(start), after: String(end) },
            ...(more
              ? {
                  next: `https://graph.facebook.com/v24.0/${FAKE_ACCOUNT_ID}/message_templates?access_token=${FAKE_TOKEN}&after=${end}`,
                }
              : {}),
          },
        }),
      );
      subscriber.complete();
    });
  }

  private response(url: string, status: number, data: unknown): AxiosResponse {
    return {
      data,
      status,
      statusText: String(status),
      headers: {},
      config: { url, headers: new AxiosHeaders() },
    };
  }

  private error(url: string, failure: FakeMetaFailure): AxiosError {
    if (failure.kind === 'network') {
      return new AxiosError(
        `connect ECONNRESET while calling ${url}?access_token=${FAKE_TOKEN}`,
        'ECONNRESET',
      );
    }
    const data =
      failure.kind === 'meta_error'
        ? {
            error: {
              message: `Synthetic failure for token ${FAKE_TOKEN}`,
              type: 'OAuthException',
              code: failure.code,
              fbtrace_id: 'synthetic-trace',
            },
          }
        : `<html>Synthetic outage ${FAKE_TOKEN}</html>`;
    return new AxiosError(
      `Request failed with status code ${failure.httpStatus}`,
      'ERR_BAD_RESPONSE',
      undefined,
      undefined,
      this.response(url, failure.httpStatus, data),
    );
  }
}
