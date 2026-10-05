# US-08-02 — Record template identity per send

- **Epic:** [E08 — WhatsApp Template Management](README.md)
- **Delivery rank:** 2 of 8
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Technical enabler
- **Status:** Done (2026-10-05). No switch: no customer-facing message changes — [evidence](../../US-08-02-TEMPLATE-IDENTITY-EVIDENCE.md)
- **Dependencies:** [US-08-01](US-08-01-meta-contract-and-live-template-reconciliation.md)

## User story and value

As Akeed staff, I want every send to record exactly which template, purpose and language reached the customer, so that I can compare reply and confirmation rates per template and language.

**Business value:** closes gap 1. The help page already tells merchants to A/B test styles, but nothing measures them today. This story also gives the US-08-03 cutover a real before/after comparison.

## Scope

- Additive columns on the dispatch ledger.
- A neutral template-selection step that runs before the dispatch claim.
- A staff-only metrics query.
- No change to any Meta payload.

**Out of scope:**
- The registry (US-08-03).
- Guardrail and fallback (US-08-04).
- Admin pages (US-08-05).
- Backfilling identity that was never recorded.
- Merchant-facing metrics.

## Acceptance criteria

1. **Identity recorded on every new dispatch.** Each new `verification_message_dispatches` row records the four fields below. They are written at claim time, from the same resolved values the Meta payload is built from. The adapter then reports what it sent, and the acceptance transaction confirms those values on the row.

   | Field | Values |
   | --- | --- |
   | variant key | for example `ar.egyptian` |
   | purpose | `initial`, `reminder` or `test` |
   | Meta template name | as sent |
   | resolved language | `ar` or `en`, plus the Meta language code actually sent, for example `ar_EG` |

2. **Purpose.**
   - `test` applies when the verification's order has `orders.is_test = true`. That covers the onboarding test and the Settings test send.
   - `reminder` applies to `follow_up` dispatches.
   - `initial` applies to every other dispatch.
3. **Identity on the verification.** Each verification shows the template name and language code of its latest accepted send. `verifications.template_name` and `language_code` are written by the acceptance transaction, in the same statement that stores `wa_message_id`, from the dispatch being accepted, so they cannot drift from the ledger (open decision 1, option a). They are `NULL` until a send is accepted, and their old defaults are dropped.
4. **Old rows.** Existing rows stay valid, with the new columns `NULL`. There is no backfill by guessing. The variant, Meta name and language of old sends are reported as "not recorded".
   - `purpose` may be backfilled only where it follows from stored data: `follow_up` → `reminder`, an `is_test` order → `test`, otherwise `initial`.
   - The `legacy_unknown` kind stays `NULL`.
   - **Decided 2026-10-05:** no backfill is run, the purpose included. Migration `0053` updates no row.
5. **Neutral selection.** Template and language selection moves from the Meta spoke into a provider-neutral step in shared messaging or the verification core. That step returns the identity, and the identity is passed to `MessagingPort.sendVerificationTemplate`. The spoke still owns the payload shape. The payload for every variant, language and path stays byte-identical, and a test proves it (see Test requirements).
6. **Metrics endpoint.** `GET /api/admin/templates/metrics?from=&to=` is behind `AdminAccessGuard`. For each template (variant key and Meta name) and language over the date range, it returns:
   - sends (accepted dispatches), split by purpose;
   - delivered and read (added 2026-10-05, from the dispatch's own receipts);
   - replies;
   - confirmations;
   - cancellations;
   - no-replies.

   Outcomes are attributed to the latest accepted dispatch before the outcome (attribution rule decided in open decision 3). Rows without identity are grouped as "not recorded", apart from the per-template rows, so they never count toward a template. The range is validated: `from` ≤ `to`, at most the maximum span set in open decision 4, and invalid input returns 400.
7. **Logs.** The resolved identity is added to the existing send logs through `buildBackendLog`. No customer name, phone or template text is logged.
8. **Other sources unaffected.** Shopify, Standalone (manual, import, API), EasyOrders and WooCommerce sends keep working, and their existing tests pass untouched.

## Open decisions (product owner)

All five were decided by the product owner on 2026-10-05.

1. What to do with `verifications.template_name` and `language_code`, which are never written today. The admin store detail shows `language_code` as `ar` even for English sends. The choices:
   - (a) write the real values on each accepted send;
   - (b) stop reading them and deprecate them with a later drop. **Recommended.**

   **Decided: (a).** The same real values also go into the dispatch row's old `template_name` and `language_code` columns, and the two defaults on `verifications` are dropped. Nothing new is written as `cod_verification` or `auto`. Existing rows are not rewritten.
2. Whether test sends appear in the metrics. The proposal is to exclude them by default and allow them with a filter. **Decided: as proposed** (`include_test=true`).
3. The attribution rule for an outcome after a reminder: credit the reminder, the first send, or both. The proposal is the latest accepted dispatch, with a per-purpose split. **Decided: as proposed.**
4. What counts as a "reply": confirmations plus cancellations only, or also unresolved typed replies. Unresolved replies are only logged today. Counting them needs a stored event, which US-08-07c would add. **Decided: confirmations plus cancellations, by the customer only.** A merchant's manual confirmation and a merchant's no-reply cancellation are not replies; the second counts as a no-reply.
5. Date-range rules: the maximum span (proposal: 92 days), and the timezone for day boundaries (proposal: UTC). **Decided: as proposed.** Both dates are calendar days, both included.

Also decided on 2026-10-05: the metrics cover every source together (Shopify, Standalone, EasyOrders and WooCommerce), with no platform filter.

## Implementation notes

- **Backend:**
  - Today the spoke resolves language and template inside [`whatsapp.service.ts`](../../../src/infrastructure/spokes/meta/whatsapp.service.ts), using [`template-language.ts`](../../../src/shared/messaging/template-language.ts) and [`cod-template-catalog.ts`](../../../src/shared/messaging/cod-template-catalog.ts). The dispatch is claimed earlier, in [`verification-send.service.ts`](../../../src/modules/verification-core/verification-send.service.ts).
  - Move selection before the claim so the identity is known when the row is written.
  - The port type stays neutral: a variant key, a Meta name string and a language code string, with no Meta JSON.
  - The metrics query lives in the admin module next to [`admin-query.repository.ts`](../../../src/modules/admin/admin-query.repository.ts).
- **Frontend:** None in this story. US-08-05 shows the metrics.
- **Data:**
  - Migration `0053_dispatch_template_identity.sql` (next free number on 2026-10-05) adds nullable columns: `template_variant_key`, `template_purpose`, `meta_template_name`, `meta_language_code` and `resolved_language`.
  - It adds an index that serves the metrics query by `accepted_at`.
  - It adds a `_journal.json` entry. No backfill is run (criterion 4).
  - It drops the defaults on `verifications.template_name` and `language_code` (open decision 1).
  - The existing dispatch columns `template_name` and `language_code` are kept, and from this story hold the Meta name and language code as sent instead of `cod_verification` and `auto`.
- **Operations:** The metrics endpoint is read-only and throttled like the other admin routes. No new environment variables.

## Test requirements

- Unit tests for the selector:
  - each of the 8 variants;
  - `auto`, `ar` and `en`;
  - an Arabic and a non-Arabic phone;
  - an invalid stored variant, which falls back to the default as today.
- **Payload characterization (prerequisite for US-08-03):** before the selector moves, record the exact Meta payload JSON for all 8 variants on the first send, the reminder and the test path. The test then asserts byte equality after the move.
- Repository tests:
  - a claim writes all identity fields;
  - a billing-exempt test claim gets `test`;
  - a follow-up gets `reminder`;
  - old rows read as "not recorded".
- Metrics tests:
  - counting and attribution with mixed purposes;
  - an empty range;
  - an invalid range returns 400;
  - non-staff gets 403/404.
- Migration test: applying it to a database with existing dispatches leaves every old row readable.
- The E01, E04, E05, E06 and E07 regression suites pass untouched. Backend `npm run lint` (non-fixing), `npm run build` and `npm run test` pass.

## Migration and rollout

- Additive only.
- **Rollback:** stop writing the new columns by reverting the code. The nullable columns can stay, or be dropped by a later numbered migration with no data loss to the existing ledger. The statements are in the header of `0053_dispatch_template_identity.sql`, and the contract suite runs them and reapplies the migration.
- No switch is needed, because no customer-facing behavior changes.

## Evidence and references

**VERIFIED FROM CODE (2026-10-05):**
- The dispatch claim writes `templateName` as `cod_verification` or `cod_verification:follow_up`, and `languageCode` from `integration.defaultLanguage ?? 'auto'` ([`verification-send.service.ts`](../../../src/modules/verification-core/verification-send.service.ts)).
- The dispatch `kind` enum is `initial`, `follow_up` or `legacy_unknown`. `verifications.template_name` and `language_code` have defaults and no writer ([`schema.ts`](../../../src/infrastructure/database/schema.ts)).
- The onboarding test order is marked `orders.is_test`.

**ASSUMPTION / REQUIRES VALIDATION:** that the purpose backfill rule matches every existing row shape. Check this with a dry-run count before applying it.

**EXTERNAL PLATFORM DEPENDENCY:** None. Meta is not called.
