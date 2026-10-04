import { EventEmitter } from 'events';
import type { request as httpsRequest, RequestOptions } from 'https';
import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import {
  createPinnedHttpsTransport,
  createRestrictedHttp,
  isPublicAddress,
  RESTRICTED_HTTP_MAX_BYTES,
  RestrictedHttpError,
  type PinnedTarget,
  type PinnedTransport,
  type RestrictedHttpResponse,
} from './restricted-http';

/** A public address the fake DNS hands out; nothing is ever sent to it. */
const PUBLIC_V4 = '93.184.216.34';

const ok = (
  overrides: Partial<RestrictedHttpResponse> = {},
): RestrictedHttpResponse => ({
  status: 200,
  headers: {},
  body: Buffer.from('{}'),
  ...overrides,
});

function harness(
  options: {
    addresses?: Record<string, string[]>;
    respond?: PinnedTransport;
    timeoutMs?: number;
  } = {},
) {
  const lookups: string[] = [];
  const targets: PinnedTarget[] = [];
  const http = createRestrictedHttp({
    timeoutMs: options.timeoutMs,
    lookup: (hostname) => {
      lookups.push(hostname);
      const addresses = options.addresses?.[hostname];
      if (!addresses) return Promise.reject(new Error('ENOTFOUND'));
      return Promise.resolve(
        addresses.map((address) => ({
          address,
          family: address.includes(':') ? 6 : 4,
        })),
      );
    },
    transport: (target) => {
      targets.push(target);
      return options.respond ? options.respond(target) : Promise.resolve(ok());
    },
  });
  return { http, lookups, targets };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RestrictedHttpError) return error.code;
    throw error;
  }
  return 'resolved';
}

describe('isPublicAddress', () => {
  it.each([
    PUBLIC_V4,
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '2606:4700:4700::1111',
    '2a00:1450:4001:81b::200e',
    `::ffff:${PUBLIC_V4}`,
    '64:ff9b::808:808',
  ])('accepts %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ['unspecified', '0.0.0.0'],
    ['this network', '0.1.2.3'],
    ['private 10/8', '10.0.0.1'],
    ['private 172.16/12', '172.16.0.1'],
    ['private 172.16/12 upper edge', '172.31.255.255'],
    ['private 192.168/16', '192.168.1.10'],
    ['loopback', '127.0.0.1'],
    ['loopback, not .1', '127.8.8.8'],
    ['link-local and cloud metadata', '169.254.169.254'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['protocol assignments', '192.0.0.8'],
    ['documentation', '203.0.113.7'],
    ['benchmarking', '198.18.0.1'],
    ['multicast', '224.0.0.1'],
    ['reserved', '240.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['IPv6 unspecified', '::'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unique local', 'fd12:3456:789a::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 link-local with a zone', 'fe80::1%eth0'],
    ['IPv6 site-local', 'fec0::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv6 documentation', '2001:db8::1'],
    ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ['6to4', '2002:a00:1::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped private, hex form', '::ffff:a00:1'],
    ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
    ['IPv4-compatible', '::10.0.0.1'],
    ['NAT64 of a private address', '64:ff9b::a00:1'],
    ['NAT64 of loopback', '64:ff9b::7f00:1'],
    ['local-use NAT64', '64:ff9b:1::1'],
    ['not an address', 'example.com'],
    ['empty', ''],
  ])('refuses %s (%s)', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('createRestrictedHttp', () => {
  const addresses = { 'store.example.com': [PUBLIC_V4] };

  it('sends one request to the address it checked, keeping the name', async () => {
    const { http, lookups, targets } = harness({ addresses });

    await expect(
      http({
        url: 'https://store.example.com/shop/wp-json/wc/v3/webhooks?page=2',
        method: 'GET',
        authorization: 'Basic abc',
      }),
    ).resolves.toMatchObject({ status: 200 });

    expect(lookups).toEqual(['store.example.com']);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      hostname: 'store.example.com',
      address: PUBLIC_V4,
      family: 4,
      path: '/shop/wp-json/wc/v3/webhooks?page=2',
      method: 'GET',
    });
  });

  it('sends only the four allowed headers', async () => {
    const { http, targets } = harness({ addresses });

    await http({
      url: 'https://store.example.com/x',
      method: 'POST',
      authorization: 'Basic abc',
      contentType: 'application/json',
      body: '{}',
    });
    await http({ url: 'https://store.example.com/x', method: 'GET' });

    expect(Object.keys(targets[0].headers).sort()).toEqual([
      'Accept',
      'Authorization',
      'Content-Type',
      'User-Agent',
    ]);
    expect(Object.keys(targets[1].headers).sort()).toEqual([
      'Accept',
      'User-Agent',
    ]);
  });

  it.each([
    ['plain HTTP', 'http://store.example.com/', 'https_required'],
    ['another scheme', 'ftp://store.example.com/', 'invalid_url'],
    ['another port', 'https://store.example.com:8443/', 'invalid_url'],
    ['credentials', 'https://user:pass@store.example.com/', 'invalid_url'],
    ['not a URL', 'store.example.com', 'invalid_url'],
  ])('refuses %s before resolving anything', async (_label, url, expected) => {
    const { http, lookups, targets } = harness({ addresses });

    await expect(codeOf(http({ url, method: 'GET' }))).resolves.toBe(expected);
    expect(lookups).toHaveLength(0);
    expect(targets).toHaveLength(0);
  });

  it('accepts the default port written out', async () => {
    const { http, targets } = harness({ addresses });

    await http({ url: 'https://store.example.com:443/x', method: 'GET' });

    expect(targets).toHaveLength(1);
  });

  it.each([
    ['a private address', ['10.1.2.3']],
    ['loopback', ['127.0.0.1']],
    ['a link-local address', ['169.254.169.254']],
    ['IPv6 loopback', ['::1']],
    ['an IPv4-mapped private address', ['::ffff:192.168.0.5']],
    ['a public and a private address together', [PUBLIC_V4, '10.0.0.5']],
    ['nothing', []],
  ])(
    'refuses a name that resolves to %s without connecting',
    async (_label, resolved) => {
      const { http, targets } = harness({
        addresses: { 'evil.example.com': resolved },
      });

      await expect(
        codeOf(http({ url: 'https://evil.example.com/', method: 'GET' })),
      ).resolves.toBe('address_not_public');
      expect(targets).toHaveLength(0);
    },
  );

  it('refuses a name that does not resolve', async () => {
    const { http, targets } = harness();

    await expect(
      codeOf(http({ url: 'https://nowhere.example.com/', method: 'GET' })),
    ).resolves.toBe('address_not_public');
    expect(targets).toHaveLength(0);
  });

  it.each([
    'https://127.0.0.1/',
    'https://10.0.0.8/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/',
    'https://[fd00::1]/',
    // Forms `URL` rewrites to 127.0.0.1.
    'https://2130706433/',
    'https://0x7f.1/',
  ])('refuses the address literal %s without connecting', async (url) => {
    const { http, lookups, targets } = harness();

    await expect(codeOf(http({ url, method: 'GET' }))).resolves.toBe(
      'address_not_public',
    );
    expect(lookups).toHaveLength(0);
    expect(targets).toHaveLength(0);
  });

  it.each([301, 302, 303, 307, 308])(
    'treats a %i as an error and never follows it',
    async (status) => {
      const { http, targets } = harness({
        addresses,
        respond: () =>
          Promise.resolve(
            ok({
              status,
              headers: { location: 'https://169.254.169.254/latest/' },
            }),
          ),
      });

      await expect(
        codeOf(http({ url: 'https://store.example.com/', method: 'GET' })),
      ).resolves.toBe('redirect');
      expect(targets).toHaveLength(1);
    },
  );

  it('gives up at the deadline when the store never answers', async () => {
    let seen: AbortSignal | undefined;
    const { http } = harness({
      addresses,
      timeoutMs: 30,
      respond: (target) => {
        seen = target.signal;
        return new Promise(() => undefined);
      },
    });

    await expect(
      codeOf(http({ url: 'https://store.example.com/', method: 'GET' })),
    ).resolves.toBe('timeout');
    expect(seen?.aborted).toBe(true);
  });

  it('gives up when the name never resolves', async () => {
    const http = createRestrictedHttp({
      timeoutMs: 30,
      lookup: () => new Promise(() => undefined),
      transport: () => Promise.resolve(ok()),
    });

    await expect(
      codeOf(http({ url: 'https://store.example.com/', method: 'GET' })),
    ).resolves.toBe('timeout');
  });

  it("stops at the caller's own budget", async () => {
    const budget = new AbortController();
    const { http } = harness({
      addresses,
      respond: () => new Promise(() => undefined),
    });

    const pending = codeOf(
      http({
        url: 'https://store.example.com/',
        method: 'GET',
        signal: budget.signal,
      }),
    );
    budget.abort();

    await expect(pending).resolves.toBe('timeout');
  });

  it('refuses a body over the cap, and caps what a caller may ask for', async () => {
    const { http, targets } = harness({
      addresses,
      respond: (target) =>
        Promise.resolve(
          ok({ body: Buffer.alloc(target.maxResponseBytes + 1) }),
        ),
    });

    await expect(
      codeOf(http({ url: 'https://store.example.com/', method: 'GET' })),
    ).resolves.toBe('response_too_large');
    await expect(
      codeOf(
        http({
          url: 'https://store.example.com/',
          method: 'GET',
          maxResponseBytes: 64 * 1024 * 1024,
        }),
      ),
    ).resolves.toBe('response_too_large');

    expect(targets[0].maxResponseBytes).toBe(1024 * 1024);
    expect(targets[1].maxResponseBytes).toBe(RESTRICTED_HTTP_MAX_BYTES);
  });

  it('reports a transport failure by code, without the remote text', async () => {
    const { http } = harness({
      addresses,
      respond: () =>
        Promise.reject(
          Object.assign(new Error('secret remote detail'), {
            code: 'CERT_HAS_EXPIRED',
          }),
        ),
    });

    const failure = await http({
      url: 'https://store.example.com/private/path',
      method: 'GET',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RestrictedHttpError);
    expect(failure).toMatchObject({
      code: 'tls_failed',
      host: 'store.example.com',
    });
    expect(String((failure as Error).message)).not.toMatch(
      /secret|private|path/,
    );
  });
});

class FakeOutgoing extends EventEmitter {
  written: string[] = [];
  ended = false;
  destroyed = false;
  write(chunk: string) {
    this.written.push(chunk);
  }
  end() {
    this.ended = true;
  }
  destroy() {
    this.destroyed = true;
  }
}

class FakeIncoming extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string | string[]>,
  ) {
    super();
  }
}

function fakeRequest() {
  const calls: {
    options: RequestOptions;
    outgoing: FakeOutgoing;
    respond: (incoming: FakeIncoming) => void;
  }[] = [];
  const request = ((
    options: RequestOptions,
    callback: (incoming: FakeIncoming) => void,
  ) => {
    const outgoing = new FakeOutgoing();
    calls.push({ options, outgoing, respond: callback });
    return outgoing;
  }) as unknown as typeof httpsRequest;
  return { request, calls };
}

function target(overrides: Partial<PinnedTarget> = {}): PinnedTarget {
  return {
    hostname: 'store.example.com',
    address: PUBLIC_V4,
    family: 4,
    path: '/wp-json/wc/v3',
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': 'Akeed' },
    maxResponseBytes: 16,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('createPinnedHttpsTransport', () => {
  it('connects to the pinned address on 443, with the name for TLS and no way around verification', async () => {
    const { request, calls } = fakeRequest();
    const pending = createPinnedHttpsTransport({ request })(target());
    const [{ options, outgoing, respond }] = calls;

    expect(options).toMatchObject({
      host: 'store.example.com',
      servername: 'store.example.com',
      port: 443,
      path: '/wp-json/wc/v3',
      method: 'GET',
      agent: false,
    });
    expect(options).not.toHaveProperty('rejectUnauthorized');
    expect(options).not.toHaveProperty('checkServerIdentity');
    expect(options).not.toHaveProperty('ca');

    const single = jest.fn();
    const all = jest.fn();
    options.lookup!('another-name.example.com', {}, single);
    options.lookup!('another-name.example.com', { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, PUBLIC_V4, 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: PUBLIC_V4, family: 4 }]);

    const incoming = new FakeIncoming(200, {
      'X-WP-TotalPages': '3',
      'set-cookie': ['a=1', 'b=2'],
    });
    respond(incoming);
    incoming.emit('data', Buffer.from('{"a":'));
    incoming.emit('data', Buffer.from('1}'));
    incoming.emit('end');

    await expect(pending).resolves.toEqual({
      status: 200,
      headers: { 'x-wp-totalpages': '3', 'set-cookie': 'a=1, b=2' },
      body: Buffer.from('{"a":1}'),
    });
    expect(outgoing.ended).toBe(true);
    expect(outgoing.written).toEqual([]);
  });

  it('writes a body with its length', () => {
    const { request, calls } = fakeRequest();
    void createPinnedHttpsTransport({ request })(
      target({ method: 'POST', body: '{"name":"é"}' }),
    ).catch(() => undefined);

    expect(calls[0].options.headers).toMatchObject({ 'Content-Length': '13' });
    expect(calls[0].outgoing.written).toEqual(['{"name":"é"}']);
  });

  it('refuses a response that declares more than the cap, without reading it', async () => {
    const { request, calls } = fakeRequest();
    const pending = createPinnedHttpsTransport({ request })(target());

    calls[0].respond(new FakeIncoming(200, { 'content-length': '17' }));

    await expect(codeOf(pending)).resolves.toBe('response_too_large');
    expect(calls[0].outgoing.destroyed).toBe(true);
  });

  it('stops reading a response that grows past the cap', async () => {
    const { request, calls } = fakeRequest();
    const pending = createPinnedHttpsTransport({ request })(target());
    const incoming = new FakeIncoming(200, {});

    calls[0].respond(incoming);
    incoming.emit('data', Buffer.alloc(10));
    incoming.emit('data', Buffer.alloc(10));
    incoming.emit('end');

    await expect(codeOf(pending)).resolves.toBe('response_too_large');
    expect(calls[0].outgoing.destroyed).toBe(true);
  });

  it.each([
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_failed'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls_failed'],
    ['CERT_HAS_EXPIRED', 'tls_failed'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_failed'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_failed'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls_failed'],
    ['EPROTO', 'tls_failed'],
    ['ECONNREFUSED', 'network'],
    ['ECONNRESET', 'network'],
    [undefined, 'network'],
  ])('reports %s as %s', async (code, expected) => {
    const { request, calls } = fakeRequest();
    const pending = createPinnedHttpsTransport({ request })(target());

    calls[0].outgoing.emit('error', Object.assign(new Error('x'), { code }));

    await expect(codeOf(pending)).resolves.toBe(expected);
  });

  it('reports an aborted exchange as a timeout', async () => {
    const { request, calls } = fakeRequest();
    const budget = new AbortController();
    const pending = createPinnedHttpsTransport({ request })(
      target({ signal: budget.signal }),
    );

    budget.abort();
    calls[0].outgoing.emit(
      'error',
      Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }),
    );

    await expect(codeOf(pending)).resolves.toBe('timeout');
  });

  describe('over a real socket', () => {
    let server: Server;
    const sockets = new Set<Socket>();

    function listen(onConnection: (socket: Socket) => void): Promise<number> {
      server = createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        onConnection(socket);
      });
      return new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve((server.address() as AddressInfo).port),
        ),
      );
    }

    afterEach(async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    });

    const loopback = (overrides: Partial<PinnedTarget> = {}) =>
      target({ address: '127.0.0.1', ...overrides });

    it('refuses a peer that does not speak TLS', async () => {
      const port = await listen((socket) =>
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'),
      );

      await expect(
        codeOf(createPinnedHttpsTransport({ port })(loopback())),
      ).resolves.toBe('tls_failed');
    });

    it('gives up on a peer that never answers', async () => {
      const port = await listen(() => undefined);

      await expect(
        codeOf(
          createPinnedHttpsTransport({ port })(
            loopback({ signal: AbortSignal.timeout(150) }),
          ),
        ),
      ).resolves.toBe('timeout');
    });
  });
});
