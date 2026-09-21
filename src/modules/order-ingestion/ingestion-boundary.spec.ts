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
      .filter((path) =>
        /^modules\/(orders|order-imports|order-ingestion)\//.test(path),
      );

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
      .filter((path) =>
        /^modules\/(orders|order-imports|order-ingestion)\//.test(path),
      );

    expect(readers).toEqual([
      'modules/order-ingestion/standalone-send-readiness.service.ts',
    ]);
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
