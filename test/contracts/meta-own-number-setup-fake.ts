/**
 * An in-process Meta Graph for setting up a merchant's own number: app
 * subscription, the number's fields, registration and the account's message
 * templates. It replaces `fetch`, so no request leaves the process and no
 * token or PIN it sees is real.
 *
 * Its answers follow Meta's documented shapes (checked 2026-11-03):
 *
 * - `GET /{waba-id}/subscribed_apps` answers `{ data: [{
 *   whatsapp_business_api_data: { id, link, name } }] }`; `POST` answers
 *   `{ success: true }`.
 * - `GET /{phone-number-id}?fields=is_on_biz_app,platform_type,...` answers
 *   the fields asked for. `is_on_biz_app: true` with `platform_type:
 *   CLOUD_API` is a Coexistence number.
 * - `POST /{phone-number-id}/register` with `{ messaging_product, pin }`
 *   answers `{ success: true }`; more than 10 requests for one number answer
 *   error `133016`.
 * - `GET /{waba-id}/message_templates` pages with `paging.cursors.after` and
 *   `paging.next`; `POST` answers `{ id, status, category }`, and a name and
 *   language that exist answer code `100`, subcode `2388024`.
 * - An error is `{ error: { message, type, code, error_subcode?, fbtrace_id
 *   } }`. Its message echoes the request, the worst case for a logger.
 *
 * Where Meta is silent the fake takes the worst case: registering an already
 * registered number succeeds silently, so only a read can tell.
 */

import {
  FAKE_BUSINESS_TOKEN,
  FAKE_DISPLAY_PHONE_NUMBER,
  FAKE_PHONE_NUMBER_ID,
  FAKE_WABA_ID,
  type FakeSignupFailure,
} from './meta-signup-fake';

export const FAKE_SETUP_APP_ID = '999653349077771';

export type SetupFakeOperation =
  | 'subscribed_apps_read'
  | 'subscribe'
  | 'phone_numbers'
  | 'phone_read'
  | 'register'
  | 'templates_list'
  | 'template_create';

export interface FakeTemplateNode {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: unknown[];
}

export interface FakeMetaSetupState {
  subscribedAppIds: Set<string>;
  phoneNumbersByWaba: Record<
    string,
    { id: string; display_phone_number: string }[]
  >;
  /** Per number; a field left undefined is left out of the answer. */
  phones: Record<
    string,
    { is_on_biz_app?: unknown; platform_type?: unknown; status?: string }
  >;
  registerCalls: Record<string, number>;
  registeredPins: Record<string, string>;
  templatesByWaba: Record<string, FakeTemplateNode[]>;
  nextTemplateId: number;
  pageSize: number;
  /** One failure per listed operation, used once each, in order. */
  failures: Partial<Record<SetupFakeOperation, FakeSetupFailure[]>>;
}

export type FakeSetupFailure =
  | FakeSignupFailure
  | {
      kind: 'meta_error_subcode';
      httpStatus: number;
      code: number;
      subcode: number;
    };

export interface RecordedSetupRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | null;
}

export function defaultSetupState(): FakeMetaSetupState {
  return {
    subscribedAppIds: new Set(),
    phoneNumbersByWaba: {
      [FAKE_WABA_ID]: [
        {
          id: FAKE_PHONE_NUMBER_ID,
          display_phone_number: FAKE_DISPLAY_PHONE_NUMBER,
        },
      ],
    },
    phones: {
      [FAKE_PHONE_NUMBER_ID]: {
        is_on_biz_app: false,
        platform_type: 'NOT_APPLICABLE',
        status: 'PENDING',
      },
    },
    registerCalls: {},
    registeredPins: {},
    templatesByWaba: { [FAKE_WABA_ID]: [] },
    nextTemplateId: 1_000_000_001,
    pageSize: 100,
    failures: {},
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function metaError(
  httpStatus: number,
  code: number,
  echo: string,
  subcode?: number,
): Response {
  return json(httpStatus, {
    error: {
      message: `Invalid request (${echo})`,
      type: 'OAuthException',
      code,
      ...(subcode !== undefined && { error_subcode: subcode }),
      fbtrace_id: 'AfakeTraceId',
    },
  });
}

export function createMetaSetupFake(
  state: FakeMetaSetupState = defaultSetupState(),
) {
  const requests: RecordedSetupRequest[] = [];

  const takeFailure = (op: SetupFakeOperation) => state.failures[op]?.shift();

  const fail = (
    failure: FakeSetupFailure,
    echo: string,
    signal?: AbortSignal | null,
  ): Promise<Response> => {
    switch (failure.kind) {
      case 'network':
        return Promise.reject(new TypeError(`fetch failed for ${echo}`));
      case 'timeout':
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
      case 'meta_error_subcode':
        return Promise.resolve(
          metaError(failure.httpStatus, failure.code, echo, failure.subcode),
        );
    }
  };

  const fetchImpl = async (
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
    const method = (init?.method ?? 'GET').toUpperCase();
    const segments = url.pathname.split('/').filter(Boolean).slice(1);
    const path = `/${segments.join('/')}`;
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: headers.get('authorization'),
    });
    const echo = `${url.href} ${typeof init?.body === 'string' ? init.body : ''}`;
    if (headers.get('authorization') !== `Bearer ${FAKE_BUSINESS_TOKEN}`)
      return metaError(401, 190, echo);

    let match = /^\/(\d+)\/subscribed_apps$/.exec(path);
    if (match) {
      const op = method === 'POST' ? 'subscribe' : 'subscribed_apps_read';
      const failure = takeFailure(op);
      if (failure) return fail(failure, echo, init?.signal);
      if (method === 'POST') {
        state.subscribedAppIds.add(FAKE_SETUP_APP_ID);
        return json(200, { success: true });
      }
      return json(200, {
        data: [...state.subscribedAppIds].map((id) => ({
          whatsapp_business_api_data: {
            id,
            link: 'https://www.facebook.com/games/?app_id=' + id,
            name: 'Akeed',
          },
        })),
      });
    }

    match = /^\/(\d+)\/phone_numbers$/.exec(path);
    if (match) {
      const failure = takeFailure('phone_numbers');
      if (failure) return fail(failure, echo, init?.signal);
      const numbers = state.phoneNumbersByWaba[match[1]];
      if (!numbers) return metaError(400, 100, echo);
      return json(200, {
        data: numbers,
        paging: { cursors: { before: 'a', after: 'b' } },
      });
    }

    match = /^\/(\d+)\/register$/.exec(path);
    if (match && method === 'POST') {
      const failure = takeFailure('register');
      state.registerCalls[match[1]] = (state.registerCalls[match[1]] ?? 0) + 1;
      if (failure) return fail(failure, echo, init?.signal);
      if (state.registerCalls[match[1]] > 10)
        return metaError(400, 133016, echo);
      const pin = (body as { pin?: unknown } | undefined)?.pin;
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin))
        return metaError(400, 100, echo);
      const existingPin = state.registeredPins[match[1]];
      if (existingPin && existingPin !== pin)
        return metaError(400, 133005, echo);
      state.registeredPins[match[1]] = pin;
      const phone = state.phones[match[1]] ?? {};
      state.phones[match[1]] = {
        ...phone,
        platform_type: 'CLOUD_API',
        status: 'CONNECTED',
      };
      return json(200, { success: true });
    }

    match = /^\/(\d+)\/message_templates$/.exec(path);
    if (match) {
      const waba = match[1];
      if (method === 'POST') {
        const failure = takeFailure('template_create');
        if (failure) return fail(failure, echo, init?.signal);
        const node = body as {
          name: string;
          language: string;
          category: string;
          components: unknown[];
        };
        const list = (state.templatesByWaba[waba] ??= []);
        if (
          list.some((t) => t.name === node.name && t.language === node.language)
        )
          return metaError(400, 100, echo, 2388024);
        const created: FakeTemplateNode = {
          id: String(state.nextTemplateId++),
          name: node.name,
          language: node.language,
          status: 'PENDING',
          category: node.category,
          components: node.components,
        };
        list.push(created);
        return json(200, {
          id: created.id,
          status: 'PENDING',
          category: node.category,
        });
      }
      const failure = takeFailure('templates_list');
      if (failure) return fail(failure, echo, init?.signal);
      const list = state.templatesByWaba[waba] ?? [];
      const start = Number(url.searchParams.get('after') ?? '0');
      const limit = Math.min(
        Number(url.searchParams.get('limit') ?? '25'),
        state.pageSize,
      );
      const page = list.slice(start, start + limit);
      const more = start + limit < list.length;
      return json(200, {
        data: page,
        paging: {
          cursors: { before: String(start), after: String(start + limit) },
          ...(more && {
            next: `https://graph.facebook.com/next?access_token=${FAKE_BUSINESS_TOKEN}`,
          }),
        },
      });
    }

    match = /^\/(\d+)$/.exec(path);
    if (match && method === 'GET') {
      const failure = takeFailure('phone_read');
      if (failure) return fail(failure, echo, init?.signal);
      const phone = state.phones[match[1]];
      if (!phone) return metaError(400, 100, echo);
      return json(200, {
        id: match[1],
        display_phone_number: FAKE_DISPLAY_PHONE_NUMBER,
        code_verification_status: 'VERIFIED',
        ...(phone.is_on_biz_app !== undefined && {
          is_on_biz_app: phone.is_on_biz_app,
        }),
        ...(phone.platform_type !== undefined && {
          platform_type: phone.platform_type,
        }),
        ...(phone.status !== undefined && { status: phone.status }),
      });
    }

    return metaError(404, 803, echo);
  };

  return { fetch: fetchImpl, requests, state };
}

/** A template as Meta would list it after creating it from Akeed's body. */
export function fakeTemplateFromBody(
  id: string,
  body: {
    name: string;
    language: string;
    category: string;
    components: unknown[];
  },
  status = 'APPROVED',
): FakeTemplateNode {
  return {
    id,
    name: body.name,
    language: body.language,
    status,
    category: body.category,
    components: body.components,
  };
}
