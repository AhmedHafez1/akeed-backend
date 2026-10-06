import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { Observable } from 'rxjs';

/**
 * An in-process Meta Graph `messages` edge for the E08 gate. No request
 * leaves the process, and no token it sees is a real one.
 *
 * Its behavior comes only from the US-08-01 contract record:
 *
 * - A customer's message opens a 24-hour customer service window, and
 *   another one resets it (4.10.1).
 * - A text is accepted while the window is open (4.10.2) and refused with
 *   131047 once it has closed (4.10.3). The HTTP status that comes with the
 *   code is not documented, so the fake uses 400.
 * - A text body is at most 4096 characters (4.10.4).
 * - A template send is accepted whatever the window says (4.10.2) and
 *   answers one message ID (4.9.8).
 * - Whether a quick-reply tap opens the window is UNKNOWN (4.10.8). The fake
 *   takes the worst case, that it does not, unless a test says otherwise.
 * - An error body is `{ error: { message, type, code, fbtrace_id } }`
 *   (4.1.10). Its message echoes the token, the worst case for a logger.
 */

export const FAKE_PHONE_NUMBER_ID = '200000000000001';
export const FAKE_MESSAGES_TOKEN = 'EAAG-fake-messages-token-never-real';
export const SERVICE_WINDOW_MS = 24 * 60 * 60_000;
export const WINDOW_CLOSED_CODE = 131047;
export const TEXT_BODY_MAX_LENGTH = 4096;

export interface FakeMetaMessageSend {
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

export type FakeMetaSendFailure =
  | { kind: 'meta_error'; httpStatus: number; code: number }
  | { kind: 'network' };

export class FakeMetaMessagesApi {
  /** Every request received, accepted or not. */
  readonly sends: FakeMetaMessageSend[] = [];
  /** Record 4.10.8 is UNKNOWN; false is its worst case. */
  buttonTapOpensWindow = false;
  now: () => number = () => Date.now();
  private readonly lastCustomerMessageAt = new Map<string, number>();
  private failure: FakeMetaSendFailure | null = null;
  private sequence = 0;

  /** The customer wrote to, or tapped a button of, the business number. */
  customerMessaged(
    phone: string,
    kind: 'text' | 'button' = 'text',
    at: number = this.now(),
  ): this {
    if (kind === 'button' && !this.buttonTapOpensWindow) return this;
    this.lastCustomerMessageAt.set(digitsOf(phone), at);
    return this;
  }

  /** The next send fails this way; the one after it does not. */
  failNextSend(failure: FakeMetaSendFailure): this {
    this.failure = failure;
    return this;
  }

  /** Stands in for `HttpService` in the messaging adapter. */
  get httpService(): {
    post: (
      url: string,
      body?: unknown,
      config?: unknown,
    ) => Observable<AxiosResponse>;
  } {
    return { post: (url, body, config) => this.post(url, body, config) };
  }

  private post(
    url: string,
    body: unknown,
    config: unknown,
  ): Observable<AxiosResponse> {
    return new Observable((subscriber) => {
      const options = (config ?? {}) as { headers?: Record<string, string> };
      const payload = (body ?? {}) as Record<string, unknown>;
      this.sends.push({
        url,
        authorization: options.headers?.Authorization,
        body: payload,
      });
      const failure = this.failure;
      this.failure = null;
      if (failure) {
        subscriber.error(this.error(url, failure));
        return;
      }
      const refuse = (httpStatus: number, code: number) =>
        subscriber.error(
          this.error(url, { kind: 'meta_error', httpStatus, code }),
        );
      if (
        !url.endsWith(`/${FAKE_PHONE_NUMBER_ID}/messages`) ||
        options.headers?.Authorization !== `Bearer ${FAKE_MESSAGES_TOKEN}`
      ) {
        refuse(401, 190);
        return;
      }
      if (payload.type === 'text') {
        const text = (payload.text ?? {}) as { body?: unknown };
        if (
          typeof text.body !== 'string' ||
          text.body.length === 0 ||
          text.body.length > TEXT_BODY_MAX_LENGTH
        ) {
          refuse(400, 100);
          return;
        }
        const openedAt = this.lastCustomerMessageAt.get(
          digitsOf(String(payload.to)),
        );
        if (
          openedAt === undefined ||
          this.now() - openedAt >= SERVICE_WINDOW_MS
        ) {
          refuse(400, WINDOW_CLOSED_CODE);
          return;
        }
      } else if (payload.type !== 'template') {
        refuse(400, 100);
        return;
      }
      this.sequence += 1;
      subscriber.next(
        this.response(url, 200, {
          messaging_product: 'whatsapp',
          messages: [{ id: `wamid.fake-${this.sequence}` }],
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

  private error(url: string, failure: FakeMetaSendFailure): AxiosError {
    if (failure.kind === 'network') {
      return new AxiosError(
        `connect ECONNRESET while calling ${url}?access_token=${FAKE_MESSAGES_TOKEN}`,
        'ECONNRESET',
      );
    }
    return new AxiosError(
      `Request failed with status code ${failure.httpStatus}`,
      'ERR_BAD_RESPONSE',
      undefined,
      undefined,
      this.response(url, failure.httpStatus, {
        error: {
          message: `Synthetic failure for token ${FAKE_MESSAGES_TOKEN}`,
          type: 'OAuthException',
          code: failure.code,
          fbtrace_id: 'synthetic-trace',
        },
      }),
    );
  }
}

function digitsOf(phone: string): string {
  return phone.replace(/\D/g, '');
}
