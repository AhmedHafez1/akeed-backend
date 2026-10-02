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

const files = productionFiles(SRC).map((path) => ({
  path: srcPath(path),
  source: readFileSync(path, 'utf8'),
}));

function under(...prefixes: string[]) {
  return files.filter(({ path }) =>
    prefixes.some((prefix) => path.startsWith(prefix)),
  );
}

/**
 * US-04.6-10 AC3, the adapter boundary: channels only translate, the ingestion
 * command owns persistence and dispatch, and the core never learns which
 * channel an order came through. `ingestion-boundary.spec.ts` pins who may
 * import the acceptance repository and who may call `dispatchById`; these
 * checks cover the rest of the release gate's architecture rules.
 */
describe('E04.6 release gate: adapter boundary', () => {
  it('builds the order envelope and fingerprint only inside the ingestion module', () => {
    const builders = files
      // Any reference, so an aliased import cannot hide a call.
      .filter(({ source }) =>
        /\b(buildStandaloneOrderEnvelope|fingerprintCanonicalOrder)\b/.test(
          source,
        ),
      )
      .map(({ path }) => path)
      .sort();

    expect(builders).toEqual([
      'modules/order-ingestion/standalone-order-ingestion.service.ts',
      'modules/order-ingestion/standalone-order-preview.ts',
      'shared/commerce/standalone-order-envelope.ts',
    ]);
  });

  it('keeps the import repositories off the orders and events tables', () => {
    // Orders and webhook events are written only by the acceptance repository
    // under StandaloneOrderIngestionService; the import repositories may only
    // write their own order_import_* tables.
    const writes = under(
      'infrastructure/database/repositories/order-imports.repository.ts',
      'infrastructure/database/repositories/order-import-release.repository.ts',
    ).flatMap(({ path, source }) =>
      [...source.matchAll(/\.(insert|update|delete)\((\w+)\)/g)].map(
        ([, verb, table]) => `${path}: ${verb} ${table}`,
      ),
    );

    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((write) => !/ orderImport\w+$/.test(write))).toEqual(
      [],
    );
  });

  it('lets bulk import touch webhook events only to release or withdraw a hold', () => {
    const calls = under('modules/order-imports/').flatMap(({ path, source }) =>
      [...source.matchAll(/this\.webhookEvents\.(\w+)/g)].map(
        ([, method]) => `${path}: ${method}`,
      ),
    );

    expect(calls.map((call) => call.split(': ')[1]).sort()).toEqual([
      'releaseHeld',
      'withdrawHeld',
      'withdrawHeld',
    ]);
    expect(
      calls
        .filter((call) => call.endsWith('releaseHeld'))
        .map((call) => call.split(': ')[0]),
    ).toEqual([
      'modules/order-imports/release/order-import-release-tick.service.ts',
    ]);
  });

  it('reads ingestionType only where the Standalone normalizer accepts the envelope', () => {
    // verification-core, the normalizers, the eligibility strategies, the
    // spokes, automation, outcomes and billing never branch on the channel.
    const readers = under(
      'modules/verification-core/',
      'modules/verification-automation/',
      'modules/commerce-outcomes/',
      'modules/webhook-queue/',
      'modules/billing/',
      'infrastructure/spokes/',
    )
      .filter(({ source }) =>
        /ingestionType|bulk_import|STANDALONE_INGESTION_CHANNELS|StandaloneIngestionChannel\b/.test(
          source,
        ),
      )
      .map(({ path }) => path);

    expect(readers).toEqual([
      'modules/webhook-queue/normalizers/standalone-manual-order.normalizer.ts',
    ]);
    const normalizer = files.find(({ path }) => path === readers[0])!.source;
    // Membership in the shared channel list, nothing more: no per-channel
    // branch, no literal channel name.
    expect(normalizer.match(/ingestionType/g)).toEqual(['ingestionType']);
    expect(normalizer).toContain(
      'isStandaloneIngestionChannel(rawPayload.ingestionType)',
    );
    expect(normalizer).not.toMatch(/'manual'|'bulk_import'|'api'/);
  });

  it('mentions ingestionType in four files of the whole backend, and nowhere else (US-05-06)', () => {
    // The envelope declares it, the ingestion service and the preview write
    // it, and the Standalone normalizer checks it is a known channel. A fifth
    // file would be a reader the three channels could start to differ in:
    // the hub, a strategy, a repository query or a report.
    const mentions = files
      .filter(({ source }) =>
        /ingestionType|ingestion_type|isStandaloneIngestionChannel|STANDALONE_INGESTION_CHANNELS/.test(
          source,
        ),
      )
      .map(({ path }) => path)
      .sort();

    expect(mentions).toEqual([
      'modules/order-ingestion/standalone-order-ingestion.service.ts',
      'modules/order-ingestion/standalone-order-preview.ts',
      'modules/webhook-queue/normalizers/standalone-manual-order.normalizer.ts',
      'shared/commerce/standalone-order-envelope.ts',
    ]);
    // The channel's type travels further (options, log-action and key-prefix
    // maps), but only inside the ingestion module and the envelope.
    expect(
      files
        .filter(({ source }) => /\bStandaloneIngestionChannel\b/.test(source))
        .map(({ path }) => path)
        .filter(
          (path) =>
            !path.startsWith('modules/order-ingestion/') &&
            path !== 'shared/commerce/standalone-order-envelope.ts',
        ),
    ).toEqual([]);
  });

  it('names the API channel only where a channel is declared or chosen (E05)', () => {
    // `'api'` is audit metadata: appended to the channel list, the key
    // namespace and the log-action map, and passed by the API controller.
    // Nothing else may compare against it.
    const literal =
      /channel:\s*'api'|\bapi:\s*'|[=!]==?\s*'api'|'api'\s*[=!]==?|^\s*'api',?\s*$/m;
    const namers = files
      .filter(({ source }) => literal.test(source))
      .map(({ path }) => path)
      .sort();

    expect(namers).toEqual([
      'modules/order-api/order-api.controller.ts',
      'modules/order-ingestion/standalone-ingestion-keys.ts',
      'modules/order-ingestion/standalone-order-ingestion.service.ts',
      'shared/commerce/standalone-order-envelope.ts',
    ]);
  });

  it('keeps the order API out of the core: nothing downstream imports it or its keys (US-05-06)', () => {
    const importers = files
      .filter(
        ({ path }) =>
          !path.startsWith('modules/order-api/') &&
          !path.startsWith('modules/integration-keys/'),
      )
      .flatMap(({ path, source }) =>
        [
          ...source.matchAll(
            /from\s+'[^']*\/(order-api|integration-keys)\/[^']*'/g,
          ),
        ].map(([, module]) => `${path}: ${module}`),
      )
      .sort();

    // Only the composition root mounts them.
    expect([...new Set(importers)]).toEqual([
      'app.module.ts: integration-keys',
      'app.module.ts: order-api',
      'main.ts: order-api',
    ]);
  });

  it('has no import-specific branch in the hub or any send path', () => {
    const sendPaths = [
      'modules/verification-core/verification-hub.service.ts',
      'modules/verification-core/verification-send.service.ts',
      'modules/webhook-queue/webhook-dispatch.service.ts',
      'modules/webhook-queue/webhook-queue.processor.ts',
      'infrastructure/spokes/meta/whatsapp.service.ts',
      'infrastructure/spokes/meta/whatsapp.webhook.service.ts',
      'infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy.ts',
    ];
    const offenders = sendPaths.flatMap((path) => {
      const file = files.find((candidate) => candidate.path === path);
      if (!file) return [`${path}: missing`];
      const matches = file.source.match(
        /bulk_import|ingestionType|importBatch|import_batch|orderImport|order_import|hold_group|holdGroup|hold_state|holdState/g,
      );
      return matches ? [`${path}: ${[...new Set(matches)].join(', ')}`] : [];
    });

    expect(offenders).toEqual([]);
  });

  it('has no import-specific retry, cancel or order-list route', () => {
    // Imported orders use the existing retry, cancel and Verifications list.
    const controller = files.find(
      ({ path }) =>
        path === 'modules/order-imports/order-imports.controller.ts',
    )!.source;
    const routes = [
      ...controller.matchAll(/@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/g),
    ].map(([, verb, route]) => `${verb} ${route}`);

    expect(routes.length).toBe(14);
    expect(
      routes.filter((route) => /retry|cancel|orders|verif/i.test(route)),
    ).toEqual([]);
  });
});
