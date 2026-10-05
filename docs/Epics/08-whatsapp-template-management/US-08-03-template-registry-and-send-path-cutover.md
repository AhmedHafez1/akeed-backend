# US-08-03 — Template registry and send-path cutover

- **Epic:** [E08 — WhatsApp Template Management](README.md)
- **Delivery rank:** 3 of 8
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Technical enabler
- **Status:** Backlog
- **Dependencies:** [US-08-02](US-08-02-record-template-identity-per-send.md)

## User story and value

As Akeed staff, I want templates defined in a database registry instead of in code, so that templates can be inspected, synced and changed without a deploy, and later stories have one place to read from.

**Business value:** removes the hard-coded catalog and the CHECK-constrained store settings. It keeps the inconsistent legacy names mapped instead of letting them leak further (gaps 7 and 9). Customers see no change.

## Scope

- A registry table seeded from the current catalog.
- Store settings that reference registry keys.
- The send path, the onboarding test and the settings response cut over to the registry.
- A characterization suite that proves byte-identical payloads.

**Out of scope:**
- Meta sync and webhooks (US-08-04).
- The guardrail and fallback on Meta status (US-08-04).
- Admin UI (US-08-05 and US-08-06).
- New templates or new copy (US-08-07).
- Removing the code catalog file before the cutover is proven.

## Acceptance criteria

1. **Registry table.** A registry table (proposed name `whatsapp_templates`) holds one row per template and language. It has:
   - stable key;
   - purpose;
   - language (`ar` or `en`);
   - Meta template name and Meta language code;
   - parameter format (`named` or `positional`);
   - variable mapping (ordered list of neutral variable keys, plus each Meta parameter name or position);
   - components snapshot (nullable until US-08-04 syncs it);
   - review status, category and quality (nullable, environment data);
   - active flag and default flag;
   - created, updated and last-synced timestamps.

   A database constraint allows at most one default per purpose and language.
2. **Seed migration.** A migration seeds the 8 current variants exactly as in [`cod-template-catalog.ts`](../../../src/shared/messaging/cod-template-catalog.ts):
   - all 8 rows are active;
   - `ar.standard` and `en.friendly` are the defaults;
   - purpose is the COD confirmation, which also serves reminder and test as today;
   - the legacy names `_akeed_cod_verification_professional` and `akeed_cod_verification_direct_` are kept verbatim.

   The seed holds no Meta template ID, status, category or quality, because those differ between the dev and prod apps and come from sync. The seed is idempotent.
3. **Store settings.** Store settings reference registry keys instead of the CHECK-constrained text:
   - New key columns on `integrations` are added first and filled from `cod_template_ar_variant` and `cod_template_en_variant`.
   - Reads and writes switch to the new columns.
   - The old columns and their CHECK constraints from [`0021`](../../../drizzle/0021_add_cod_template_variants.sql) stay until a later migration removes them, after the gate.
   - A write that names an unknown, inactive or wrong-language key is rejected with a clear error.
4. **Send path.** The send path, the onboarding test and the `GET /api/settings` template block (variants, defaults, selected, previews) read from the registry, through a neutral repository and selector. The settings response shape does not change, so the frontend is untouched.
5. **Byte-identical payloads.** Before and after the cutover, the Meta payload is byte-identical:
   - for all 8 variants;
   - on the first send, the reminder and the onboarding test;
   - with `auto`, forced `ar` and forced `en`;
   - with and without customer and store names.

   A characterization test written before the cutover and kept afterwards proves it.
6. **Fallback for unknown stored values.** An integration whose stored value matches no active registry row resolves to the language default, as the code does today for an invalid variant. The fallback is logged with a reason.
7. **Neutral types.** Verification core, the hub and the frontend see neutral types only: key, purpose, language, variables. Meta names, language codes and component JSON are read only inside the Meta spoke and the registry repository.
8. **Preview text.** Until US-08-07g, preview text is carried as a registry column or table seeded from the current preview blocks, so Settings and the onboarding test look unchanged.

## Open decisions (product owner)

1. **Stable key scheme.** The proposal is `cod_confirm.<language>.<style>`, for example `cod_confirm.ar.egyptian`. The other choice is to keep today's variant ids (`standard`, `friendly`) with the language as a separate column.
2. **Registry scope.** The proposal is global keys, purposes and mappings in one table, with Meta-side fields (template ID, status, quality, snapshot) filled per environment by sync. Each deployment has its own database, so a separate per-environment table is not needed. Please confirm.
3. **Dropping the old columns.** The proposal is a separate migration after US-08-08, not in this story.
4. **Purpose of the 8 seeded rows.** The proposal is the single purpose `cod_confirmation`, used for initial, reminder and test as today. US-08-07a adds a distinct `cod_reminder` purpose.

## Implementation notes

- **Backend:**
  - Replace the catalog lookups in [`whatsapp.service.ts`](../../../src/infrastructure/spokes/meta/whatsapp.service.ts), [`onboarding-test.service.ts`](../../../src/modules/verifications/onboarding-test.service.ts), [`onboarding-state.service.ts`](../../../src/modules/onboarding/onboarding-state.service.ts) and [`onboarding.service.ts`](../../../src/modules/onboarding/onboarding.service.ts) with the registry selector introduced in US-08-02.
  - Cache the registry in memory with a short TTL. The cache is invalidated by later admin writes.
  - Keep the catalog file only as the seed source and characterization baseline until the gate.
- **Frontend:** No change: the settings response is unchanged.
- **Data:**
  - Migrations follow the next free numbers after US-08-02:
    - create and seed the registry (with an RLS policy limited to the service role, like the other staff tables);
    - add and fill the `integrations` key columns.
  - Each has a `_journal.json` entry and a written rollback.
- **Operations:** No environment variable. The registry must be seeded before the new code serves traffic. Migrations run at boot through `runMigrations()`.

## Test requirements

- **Characterization suite:** the full matrix in criterion 5, as an exact JSON comparison. It is committed before the cutover commit and must pass on both sides of it.
- Registry repository tests:
  - seed idempotency;
  - one default per purpose and language;
  - an inactive row is not selectable;
  - unknown-key fallback.
- Settings tests:
  - PATCH with a valid key, an unknown key, an inactive key and a wrong-language key;
  - the GET response is unchanged (snapshot against the pre-cutover response).
- The onboarding test service returns the same preview and sample as before.
- The E01, E04, E05, E06 and E07 regression suites pass untouched. Backend lint (non-fixing), build and test pass. The frontend is unchanged.

## Migration and rollout

- **Additive.** New table and new columns first. The old variant columns and CHECKs stay.
- **Rollback:** revert the code and the send path reads the catalog again. The old columns are still kept in sync until they are dropped, because writes go to both until the gate.
- Write the dual-write rule into the migration notes and say when it ends.

## Evidence and references

**VERIFIED FROM CODE (2026-10-05):**
- The 8 variants, 6 Meta names, defaults and parameter orders are as listed in the [epic README](README.md#current-state-verified-from-code-2026-10-05).
- `integrations.cod_template_ar_variant` and `cod_template_en_variant` are constrained by CHECKs ([`0021_add_cod_template_variants.sql`](../../../drizzle/0021_add_cod_template_variants.sql), [`schema.ts`](../../../src/infrastructure/database/schema.ts)).
- Invalid stored variants fall back to the default through `isArabicCodTemplateVariant` and `isEnglishCodTemplateVariant` ([`verification-send.service.ts`](../../../src/modules/verification-core/verification-send.service.ts)).
- No payload snapshot test exists today.

**ASSUMPTION / REQUIRES VALIDATION:** that the US-08-01 record confirms the code catalog's names, codes and parameter formats are what Meta has approved in both environments. Where it does not, the code's current payload is still the baseline: this story changes nothing customers see.

**EXTERNAL PLATFORM DEPENDENCY:** None. Meta is not called.
