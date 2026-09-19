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
    });
  });
});
