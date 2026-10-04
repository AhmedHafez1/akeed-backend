import { lookup as dnsLookup } from 'dns/promises';
import { request as httpsRequest } from 'https';
import { BlockList, isIP, type LookupFunction } from 'net';

/**
 * Restricted outbound HTTP for hosts a merchant names.
 *
 * `bounded-http.ts` gives a call a deadline and opt-in retries and says
 * nothing about where the call goes. A store URL is merchant-supplied, so a
 * request to it is a way to reach whatever the API can reach: a cloud
 * metadata address, an internal service, a host that redirects to either.
 * Every request to a store goes through here instead:
 *
 * - `https:` on port 443 only.
 * - The host is resolved once and every address it returns must be public.
 * - The connection is made to the address that was checked. The name is not
 *   resolved a second time, and stays in use for SNI and the certificate.
 * - Certificates are verified. Nothing here can turn that off.
 * - A redirect is an error, never followed, so credentials are not forwarded.
 * - One deadline for the whole exchange and a cap on the response body.
 * - No retry: a caller that may repeat a call says so, as with `boundedCall`.
 */

export const RESTRICTED_HTTP_TIMEOUT_MS = 10_000;
export const RESTRICTED_HTTP_DEFAULT_MAX_BYTES = 1024 * 1024;
/** The largest cap a caller may ask for. */
export const RESTRICTED_HTTP_MAX_BYTES = 2 * 1024 * 1024;

const USER_AGENT = 'Akeed';

export type RestrictedHttpErrorCode =
  | 'invalid_url'
  | 'https_required'
  | 'address_not_public'
  | 'redirect'
  | 'tls_failed'
  | 'timeout'
  | 'response_too_large'
  | 'network';

/** Carries a code and the host. Never anything the remote side said. */
export class RestrictedHttpError extends Error {
  constructor(
    readonly code: RestrictedHttpErrorCode,
    readonly host: string | null,
  ) {
    super(`Restricted outbound request refused: ${code}`);
    this.name = 'RestrictedHttpError';
  }
}

export interface RestrictedHttpRequest {
  /** Built by the caller from a stored URL and a fixed path. */
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  authorization?: string;
  contentType?: string;
  body?: string;
  /** Default 1 MiB, at most 2 MiB. */
  maxResponseBytes?: number;
  /** An outer budget; the request's own deadline applies as well. */
  signal?: AbortSignal;
}

export interface RestrictedHttpResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: Buffer;
}

export type RestrictedHttp = (
  request: RestrictedHttpRequest,
) => Promise<RestrictedHttpResponse>;

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type RestrictedLookup = (hostname: string) => Promise<ResolvedAddress[]>;

/** One HTTPS exchange with an address the caller has already checked. */
export interface PinnedTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
  path: string;
  method: RestrictedHttpRequest['method'];
  headers: Record<string, string>;
  body?: string;
  maxResponseBytes: number;
  signal: AbortSignal;
}

export type PinnedTransport = (
  target: PinnedTarget,
) => Promise<RestrictedHttpResponse>;

const NON_PUBLIC_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NON_PUBLIC_V4.addSubnet(network, prefix, 'ipv4');

/** Inside global unicast (2000::/3) and still not a public host. */
const NON_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const)
  NON_PUBLIC_V6.addSubnet(network, prefix, 'ipv6');

/** IPv4-mapped (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) prefixes. */
const EMBEDDED_V4_PREFIXES = [
  [0, 0, 0, 0, 0, 0xffff],
  [0x64, 0xff9b, 0, 0, 0, 0],
];

function parseIpv6Groups(address: string): number[] | null {
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const read = (part: string) =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const head = read(halves[0]);
  const rest = halves.length === 2 ? read(halves[1]) : [];
  const groups =
    halves.length === 2
      ? [
          ...head,
          ...new Array<number>(8 - head.length - rest.length).fill(0),
          ...rest,
        ]
      : head;
  return groups.length === 8 && groups.every((group) => group >= 0)
    ? groups
    : null;
}

/**
 * Whether an address is a public host. Fails closed: anything that is not
 * plainly a public unicast address is refused, in both families, including
 * an IPv4 address carried inside an IPv6 one.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, 'ipv4');
  // A zone id names a local interface.
  if (family !== 6 || address.includes('%')) return false;
  const groups = parseIpv6Groups(address);
  if (!groups) return false;
  if (
    EMBEDDED_V4_PREFIXES.some((prefix) =>
      prefix.every((group, index) => groups[index] === group),
    )
  ) {
    const [high, low] = groups.slice(6);
    return isPublicAddress(
      [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'),
    );
  }
  if ((groups[0] & 0xe000) !== 0x2000) return false;
  return !NON_PUBLIC_V6.check(address, 'ipv6');
}

const TLS_ERROR_CODE =
  /^(CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|HOSTNAME_MISMATCH|ERR_TLS_|ERR_SSL_|EPROTO$)/;

function toTransportError(
  error: unknown,
  target: Pick<PinnedTarget, 'hostname' | 'signal'>,
): RestrictedHttpError {
  if (error instanceof RestrictedHttpError) return error;
  if (target.signal.aborted)
    return new RestrictedHttpError('timeout', target.hostname);
  const code =
    error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
  return new RestrictedHttpError(
    typeof code === 'string' && TLS_ERROR_CODE.test(code)
      ? 'tls_failed'
      : 'network',
    target.hostname,
  );
}

function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/**
 * The socket half. `request` and `port` are parameters only so the spec can
 * drive it without a real store; production uses `https.request` on 443.
 */
export function createPinnedHttpsTransport(
  options: { request?: typeof httpsRequest; port?: number } = {},
): PinnedTransport {
  const request = options.request ?? httpsRequest;
  const port = options.port ?? 443;
  return (target) =>
    new Promise<RestrictedHttpResponse>((resolve, reject) => {
      let settled = false;
      const outgoing = request(
        {
          host: target.hostname,
          servername: target.hostname,
          port,
          path: target.path,
          method: target.method,
          headers:
            target.body === undefined
              ? target.headers
              : {
                  ...target.headers,
                  'Content-Length': String(Buffer.byteLength(target.body)),
                },
          // A new connection each time: nothing pooled could carry a request
          // to an address that was checked for an earlier one.
          agent: false,
          lookup: pinnedLookup(target.address, target.family),
          signal: target.signal,
        },
        (incoming) => {
          const declared = Number(incoming.headers['content-length']);
          if (Number.isFinite(declared) && declared > target.maxResponseBytes)
            return fail(
              new RestrictedHttpError('response_too_large', target.hostname),
            );
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > target.maxResponseBytes)
              return fail(
                new RestrictedHttpError('response_too_large', target.hostname),
              );
            chunks.push(chunk);
          });
          incoming.on('error', (error) => fail(error));
          incoming.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({
              status: incoming.statusCode ?? 0,
              headers: Object.fromEntries(
                Object.entries(incoming.headers).map(([name, value]) => [
                  name.toLowerCase(),
                  Array.isArray(value) ? value.join(', ') : (value ?? ''),
                ]),
              ),
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      function fail(error: unknown): void {
        if (settled) return;
        settled = true;
        outgoing.destroy();
        reject(toTransportError(error, target));
      }
      outgoing.on('error', (error) => fail(error));
      if (target.body !== undefined) outgoing.write(target.body);
      outgoing.end();
    });
}

function systemLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function parseTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RestrictedHttpError('invalid_url', null);
  }
  if (url.protocol === 'http:')
    throw new RestrictedHttpError('https_required', url.hostname);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    // `URL` drops the default port, so anything left is another port.
    url.port ||
    !url.hostname
  )
    throw new RestrictedHttpError('invalid_url', url.hostname || null);
  return url;
}

function whenAborted(signal: AbortSignal, host: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const refuse = () => reject(new RestrictedHttpError('timeout', host));
    if (signal.aborted) refuse();
    else signal.addEventListener('abort', refuse, { once: true });
  });
}

async function resolvePublicAddress(
  host: string,
  lookup: RestrictedLookup,
): Promise<ResolvedAddress> {
  const literal = isIP(host);
  let addresses: ResolvedAddress[];
  if (literal) addresses = [{ address: host, family: literal }];
  else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new RestrictedHttpError('address_not_public', host);
    }
  }
  // One bad address refuses the request: which one a second resolution
  // would hand out is not ours to choose.
  if (
    addresses.length === 0 ||
    !addresses.every(({ address }) => isPublicAddress(address))
  )
    throw new RestrictedHttpError('address_not_public', host);
  return addresses[0];
}

export function createRestrictedHttp(
  deps: {
    lookup?: RestrictedLookup;
    transport?: PinnedTransport;
    timeoutMs?: number;
  } = {},
): RestrictedHttp {
  const lookup = deps.lookup ?? systemLookup;
  const transport = deps.transport ?? createPinnedHttpsTransport();
  const timeoutMs = deps.timeoutMs ?? RESTRICTED_HTTP_TIMEOUT_MS;

  return async (request) => {
    const url = parseTarget(request.url);
    // `URL` keeps the brackets of an IPv6 literal.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const maxResponseBytes = Math.min(
      request.maxResponseBytes ?? RESTRICTED_HTTP_DEFAULT_MAX_BYTES,
      RESTRICTED_HTTP_MAX_BYTES,
    );
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([deadline, request.signal])
      : deadline;
    const aborted = whenAborted(signal, host);
    // Settled by the race below or never; either way not an unhandled one.
    aborted.catch(() => undefined);

    const exchange = async (): Promise<RestrictedHttpResponse> => {
      const { address, family } = await resolvePublicAddress(host, lookup);
      try {
        return await transport({
          hostname: host,
          address,
          family: family === 6 ? 6 : 4,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: {
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
            ...(request.authorization
              ? { Authorization: request.authorization }
              : {}),
            ...(request.contentType
              ? { 'Content-Type': request.contentType }
              : {}),
          },
          body: request.body,
          maxResponseBytes,
          signal,
        });
      } catch (error) {
        throw toTransportError(error, { hostname: host, signal });
      }
    };

    const response = await Promise.race([exchange(), aborted]);
    if (response.status >= 300 && response.status < 400)
      throw new RestrictedHttpError('redirect', host);
    if (response.body.length > maxResponseBytes)
      throw new RestrictedHttpError('response_too_large', host);
    return response;
  };
}
