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

const files = productionFiles(SRC).map((path) => ({
  path: relative(SRC, path).replace(/\\/g, '/'),
  source: readFileSync(path, 'utf8'),
}));

function filesMatching(pattern: RegExp, scope?: RegExp): string[] {
  return files
    .filter(({ path }) => !scope || scope.test(path))
    .filter(({ source }) => pattern.test(source))
    .map(({ path }) => path)
    .sort();
}

const CHANNELS = /^modules\/(orders|order-imports|order-ingestion)\//;

/**
 * US-04.6-10 AC3: the epic README "Reuse map" row by row. Every rule the
 * manual path and the import share exists exactly once; a second copy is a
 * place for the two paths to drift apart.
 */
describe('E04.6 release gate: one implementation per rule (Reuse map)', () => {
  it('source resolution: one resolver decides the writable Standalone source', () => {
    expect(
      filesMatching(
        /platformType\s*!==\s*'standalone'|\.findActiveByOrg\(/,
        CHANNELS,
      ),
    ).toEqual(['modules/order-ingestion/standalone-source-resolver.ts']);
    expect(filesMatching(/onboardingStatus/, CHANNELS)).toEqual([
      'modules/order-ingestion/standalone-send-readiness.service.ts',
      'modules/order-ingestion/standalone-source-resolver.ts',
    ]);
  });

  it('send readiness: the credit and slot gates are read only by the readiness service and the core', () => {
    // Anywhere in src, not only the channels: the core's own send-time gates
    // are the transactional truth the advisory readiness check mirrors.
    expect(filesMatching(/\.(resolveDenial|hasAvailableSlot)\(/)).toEqual([
      'modules/order-ingestion/standalone-send-readiness.service.ts',
      'modules/verification-core/verification-hub.service.ts',
      'modules/verification-core/verification-send.service.ts',
    ]);
  });

  it('canonical field rules: one currency list and one totalPrice pattern', () => {
    // A list is three or more ISO codes in a row; symbol-to-code alias tables
    // (order-imports/validation/currency.ts) derive from the shared list.
    expect(filesMatching(/\[\s*(?:'[A-Z]{3}'\s*,\s*){2,}'[A-Z]{3}'/)).toEqual([
      'shared/commerce/canonical-order.rules.ts',
    ]);
    expect(filesMatching(/\[1-9\]\\d\{0,9\}/)).toEqual([
      'shared/commerce/canonical-order.rules.ts',
    ]);
    expect(
      filesMatching(
        /ONBOARDING_SHIPPING_CURRENCIES\s*=\s*CANONICAL_ORDER_CURRENCIES/,
      ),
    ).toEqual(['modules/onboarding/dto/onboarding.dto.ts']);
  });

  it('COD eligibility: bulk import never re-decides COD itself', () => {
    // The row's ready/excluded decision is OrderEligibilityService's; import
    // code only maps merchant values to a canonical payment method.
    expect(
      filesMatching(
        /\.assumeCodWhenPaymentMissing\b|classifyCodStatus/,
        /^modules\/order-imports\//,
      ),
    ).toEqual([]);
  });

  it('phone parsing: one libphonenumber instance', () => {
    expect(filesMatching(/PhoneNumberUtil|google-libphonenumber/)).toEqual([
      'shared/services/phone.service.ts',
    ]);
  });

  it('idempotency-key validation: one pattern for the order channels', () => {
    // KNOWN, outside the Reuse map: two staff billing endpoints kept their own
    // copies before E04.6 (recorded in US-04.6-06 and US-04.6-10 evidence as
    // follow-ups). No order channel may add another.
    expect(filesMatching(/\[A-Za-z0-9\._:-\]|\[A-Za-z0-9\._:\\-\]/)).toEqual([
      'modules/admin/billing-observability.service.ts',
      'modules/admin/standalone-billing-operator.guard.ts',
      'shared/validation/idempotency-key.ts',
    ]);
  });

  it('ingestion command and acceptance: orders and events are inserted by one repository', () => {
    const inserts = files.flatMap(({ path, source }) =>
      [...source.matchAll(/\.insert\((orders|webhookEvents)\)/g)].map(
        ([, table]) => `${path}: ${table}`,
      ),
    );

    expect(inserts.sort()).toEqual([
      // Standalone: every channel, through StandaloneOrderIngestionService.
      'infrastructure/database/repositories/manual-order-ingestion.repository.ts: orders',
      'infrastructure/database/repositories/manual-order-ingestion.repository.ts: webhookEvents',
      // Shopify: the hub's order insert and the webhook intake, both
      // pre-existing and unreachable from any Standalone channel.
      'infrastructure/database/repositories/orders.repository.ts: orders',
      'infrastructure/database/repositories/webhook-events.repository.ts: webhookEvents',
    ]);
  });

  it('quiet hours: bulk import reuses the shared time-window maths', () => {
    const importers = filesMatching(
      /quiet-hours\.util'/,
      /^modules\/order-imports\//,
    );
    expect(importers).toEqual([
      'modules/order-imports/release/order-import-release-tick.service.ts',
      'modules/order-imports/release/order-import-release.service.ts',
      // The start quote's duration estimate.
      'modules/order-imports/release/release-policy.ts',
    ]);
    // The raw window is only echoed in the start quote for display; every
    // decision goes through quietHoursConfigOf / isInsideQuietHours.
    expect(
      filesMatching(
        /quietHoursStart|quietHoursEnd/,
        /^modules\/order-imports\//,
      ),
    ).toEqual([
      'modules/order-imports/release/order-import-release.service.ts',
    ]);
    expect(
      filesMatching(
        /quietHours(Start|End)[^,\n]*\.split\(|\.getHours\(\)/,
        /^modules\/order-imports\//,
      ),
    ).toEqual([]);
  });

  it('order list: imported orders are listed only by the Verifications query', () => {
    expect(
      filesMatching(
        /importBatchId/,
        /^infrastructure\/database\/repositories\//,
      ),
    ).toEqual([
      'infrastructure/database/repositories/verifications.repository.ts',
    ]);
    expect(
      filesMatching(
        /from\s+'[^']*schema'[\s\S]*\bverifications\b/,
        /^infrastructure\/database\/repositories\/order-import/,
      ),
    ).toEqual([]);
  });
});
