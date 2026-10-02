import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../..');

function productionFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return productionFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

function srcPath(path: string): string {
  return relative(SRC, path).replace(/\\/g, '/');
}

/** Every Standalone channel and the command they share. */
const CHANNELS = /^modules\/(orders|order-imports|order-api|order-ingestion)\//;

/**
 * `StandaloneOrderIngestionService` is the only way a Standalone order enters
 * Akeed. A channel that wrote through the repository or dispatched on its own
 * would bypass the envelope, the hold and the idempotency namespacing, and
 * could contact a customer from a path nobody reviews for that.
 */
describe('Standalone ingestion boundary', () => {
  const files = productionFiles(SRC).map((path) => ({
    path: srcPath(path),
    source: readFileSync(path, 'utf8'),
  }));

  it('lets only the ingestion service use the acceptance repository', () => {
    const importers = files
      .filter(({ source }) =>
        /from\s+'[^']*manual-order-ingestion\.repository'/.test(source),
      )
      .map(({ path }) => path)
      .sort();

    expect(importers).toEqual([
      'infrastructure/database/database.module.ts',
      'modules/order-ingestion/standalone-order-ingestion.service.ts',
    ]);
  });

  it('resolves the writable Standalone source in one place', () => {
    const deciders = files
      .filter(({ source }) =>
        /platformType\s*!==\s*'standalone'|\.findActiveByOrg\(/.test(source),
      )
      .map(({ path }) => path)
      .filter((path) => CHANNELS.test(path));

    expect(deciders).toEqual([
      'modules/order-ingestion/standalone-source-resolver.ts',
    ]);
  });

  it('decides send readiness in one place', () => {
    // Manual create, manual retry and the import quote, start, resume and
    // release tick all ask StandaloneSendReadinessService; none of them reads
    // the credit or usage gates on its own.
    const readers = files
      .filter(({ source }) =>
        /\.(resolveDenial|hasAvailableSlot)\(/.test(source),
      )
      .map(({ path }) => path)
      .filter((path) => CHANNELS.test(path));

    expect(readers).toEqual([
      'modules/order-ingestion/standalone-send-readiness.service.ts',
    ]);
  });

  it('gates a single submission in one place', () => {
    // The manual form and the API both enter through `submitOne`; neither
    // evaluates readiness for a new order or maps its blockers on its own.
    const gates = files
      .filter(({ source }) => /\bassertSendReady\(/.test(source))
      .map(({ path }) => path)
      .sort();

    expect(gates).toEqual([
      'modules/order-ingestion/standalone-order-ingestion.service.ts',
      'modules/order-ingestion/standalone-readiness-gate.ts',
    ]);
  });

  describe('the order API is a channel adapter and nothing else (E05)', () => {
    const api = files.filter(({ path }) =>
      path.startsWith('modules/order-api/'),
    );

    // The channel: what turns a request into a canonical order.
    const channel = api.filter(
      ({ path }) => !path.startsWith('modules/order-api/edge/'),
    );
    // The protection around it (US-05-04): rate limits, the error envelope
    // and the request log. It knows who is calling and nothing about orders.
    const edge = api.filter(({ path }) =>
      path.startsWith('modules/order-api/edge/'),
    );

    it('holds a controller, a request DTO, an adapter, its module and the edge', () => {
      expect(channel.map(({ path }) => path).sort()).toEqual([
        'modules/order-api/api-order.channel-adapter.ts',
        'modules/order-api/dto/create-api-order.dto.ts',
        'modules/order-api/order-api.controller.ts',
        'modules/order-api/order-api.module.ts',
      ]);
      expect(edge.map(({ path }) => path).sort()).toEqual([
        'modules/order-api/edge/order-api-exception.filter.ts',
        'modules/order-api/edge/order-api-outcome.interceptor.ts',
        'modules/order-api/edge/order-api-request-state.ts',
        'modules/order-api/edge/order-api-throttle.guard.ts',
        'modules/order-api/edge/order-api.edge.ts',
        'modules/order-api/edge/order-api.errors.ts',
      ]);
    });

    it('keeps the edge away from orders: no ingestion, repository, DTO or request body', () => {
      const offenders = edge
        .filter(({ source }) =>
          /from\s+'[^']*(\/order-ingestion\/|\/repositories\/|\/dto\/|channel-adapter)[^']*'|\.(body|rawBody)\b|headers\.authorization/.test(
            source,
          ),
        )
        .map(({ path }) => path);

      expect(offenders).toEqual([]);
    });

    it('imports nothing that persists, dispatches, bills or builds an envelope', () => {
      const forbidden =
        /from\s+'[^']*(manual-order-ingestion\.repository|webhook-events\.repository|webhook-dispatch\.service|credit-eligibility\.service|billing-entitlement\.service|standalone-send-readiness\.service|standalone-order-envelope|standalone-order-preview|\/verification-core\/|google-libphonenumber|\/repositories\/orders\.repository)[^']*'/g;
      const offenders = api.flatMap(({ path, source }) =>
        [...source.matchAll(forbidden)].map(
          ([, target]) => `${path}: ${target}`,
        ),
      );

      expect(offenders).toEqual([]);
    });

    it('reaches the database, the queues and the providers through nothing of its own (US-05-06)', () => {
      // The named list above is the README's; this is the rule behind it. The
      // module file wires DatabaseModule for the key guard, and nothing else
      // in the module may name a repository, the schema, a queue or a spoke.
      const reaches = api.flatMap(({ path, source }) =>
        [
          ...source.matchAll(
            /from\s+'([^']*(?:\/infrastructure\/|\/webhook-queue\/|\/verification-automation\/|\/commerce-outcomes\/|\/billing\/|\/orders\/|\/order-imports\/)[^']*|bullmq|@nestjs\/bullmq|drizzle-orm[^']*|postgres)'/g,
          ),
        ].map(([, target]) => `${path}: ${target}`),
      );

      expect(reaches).toEqual([
        'modules/order-api/order-api.module.ts: ../../infrastructure/database/database.module',
      ]);
    });

    it('never holds an order: the hold primitive stays with file import', () => {
      expect(
        api
          .filter(({ source }) =>
            /\bhold\s*:|holdGroup|hold_state/.test(source),
          )
          .map(({ path }) => path),
      ).toEqual([]);
    });

    it('reaches the ingestion command only through submitOne', () => {
      const calls = api.flatMap(({ path, source }) =>
        [
          ...source.matchAll(
            /\.(submitOne|acceptOne|acceptMany|dispatchById|evaluate|resolveWritable|resolveWritableSource|resolveForIntegration)\(/g,
          ),
        ].map(([, method]) => `${path}: ${method}`),
      );

      expect(calls).toEqual([
        'modules/order-api/order-api.controller.ts: submitOne',
      ]);
      expect(
        api.filter(({ source }) =>
          /buildStandaloneOrderEnvelope|fingerprintCanonicalOrder|PhoneNumberUtil|classifyCodStatus|assertSendReady/.test(
            source,
          ),
        ),
      ).toEqual([]);
    });

    it('declares no limit, pattern or currency list of its own', () => {
      // Every field rule is read from canonical-order.rules.ts; the only
      // literal the module may hold is text.
      const declared = api.flatMap(({ path, source }) =>
        [
          ...source.matchAll(
            /@(?:Min|Max)?Length\(\s*\d|@Matches\(\s*\/|@IsIn\(\s*\[|new RegExp\(|=\s*\/\S/g,
          ),
        ].map(([match]) => `${path}: ${match}`),
      );

      expect(declared).toEqual([]);
    });

    it('takes the tenant from the API key, never from a session or the body', () => {
      const controller = api.find(({ path }) =>
        path.endsWith('order-api.controller.ts'),
      )!.source;

      // The key guard sits between the pre-auth ceiling and the limits of the
      // integration it authenticated; all three run before the handler.
      expect(controller).toMatch(
        /@UseGuards\(\s*OrderApiIngressThrottleGuard,\s*IntegrationApiKeyGuard,\s*OrderApiThrottleGuard,?\s*\)/,
      );
      expect(controller).not.toMatch(/DualAuthGuard|CurrentUser\b/);
      // The edge names the tenant to throttle and log it, read from the key's
      // principal; the channel never names it at all.
      expect(
        channel.filter(({ source }) =>
          /\b(orgId|integrationId)\b/.test(source),
        ),
      ).toEqual([]);
    });
  });

  describe('integration API keys are credentials and nothing else (E05)', () => {
    const keys = files.filter(({ path }) =>
      path.startsWith('modules/integration-keys/'),
    );

    it('touch only their own table, and resolve the source through the ingestion command', () => {
      const repositories = keys.flatMap(({ path, source }) =>
        [...source.matchAll(/from\s+'[^']*\/repositories\/([^']+)'/g)].map(
          ([, repository]) => `${path}: ${repository}`,
        ),
      );

      expect(repositories.sort()).toEqual([
        'modules/integration-keys/guards/integration-api-key.guard.ts: integration-api-keys.repository',
        'modules/integration-keys/integration-keys.service.ts: integration-api-keys.repository',
      ]);
      expect(
        keys
          .filter(({ source }) =>
            /\.findActiveByOrg\(|platformType|onboardingStatus|\.(submitOne|acceptOne|acceptMany|dispatchById)\(/.test(
              source,
            ),
          )
          .map(({ path }) => path),
      ).toEqual([]);
    });

    it('are read by the guard alone: the core never learns which credential sent an order', () => {
      // The principal's key id and prefix are log metadata. Only the key
      // module, the API module and the principal's type may name them.
      const readers = files
        .filter(({ source }) =>
          /\bkeyId\b|\bkeyPrefix\b|integrationApiKey\b|IntegrationApiKeyPrincipal\b/.test(
            source,
          ),
        )
        .map(({ path }) => path)
        .filter(
          (path) =>
            !path.startsWith('modules/integration-keys/') &&
            !path.startsWith('modules/order-api/'),
        )
        .sort();

      expect(readers).toEqual([
        'modules/order-ingestion/standalone-order-ingestion.types.ts',
      ]);
    });
  });

  it('keeps manual orders out of the bulk-import release path', () => {
    // Manual orders dispatch inline from acceptance; nothing in orders may
    // reach the import scheduler, so an import in progress cannot delay one.
    const couplings = files
      .filter(({ path }) => path.startsWith('modules/orders/'))
      .filter(({ source }) => /order-imports|order-import-release/.test(source))
      .map(({ path }) => path);

    expect(couplings).toEqual([]);
  });

  it('dispatches only from the dispatch paths that already existed', () => {
    const callers = Object.fromEntries(
      files
        .map(({ path, source }): [string, number] => [
          path,
          source.match(/\.dispatchById\(/g)?.length ?? 0,
        ])
        .filter(([, count]) => count !== 0),
    );

    expect(callers).toEqual({
      // Shopify webhook ingestion and the recovery sweep.
      'modules/webhook-queue/webhook-queue.producer.ts': 1,
      'modules/webhook-queue/webhook-dispatch-reconciler.service.ts': 2,
      // Standalone acceptance.
      'modules/order-ingestion/standalone-order-ingestion.service.ts': 1,
      // The merchant retry endpoint, and nothing else in orders.
      'modules/orders/orders.service.ts': 1,
      // Staff resolution of an unknown provider outcome. Like merchant retry it
      // re-drives through `resetForRedispatch`, which refuses held and
      // withdrawn events.
      'modules/admin/message-dispatch-resolution.service.ts': 1,
      // The bulk-import release scheduler: the only code in E04.6 allowed to
      // turn a held order into a send (epic invariant 6), and only for events
      // `releaseHeld` has just released.
      'modules/order-imports/release/order-import-release-tick.service.ts': 1,
    });
  });
});
