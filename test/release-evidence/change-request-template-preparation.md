# Production template preparation verification

Observed 9 November 2026, Africa/Cairo. The owner authorized develop commits/pushes, bounded production schema/draft preparation, and isolated synthetic verification. Provider submission/upload, application deployment and merchant activation remain separate.

## Delivered behavior

- Existing draft authoring carries immutable predecessor linkage and the fixed localized third label through API reads, editing, validation, preview and submission review. Ordinary drafts retain two buttons. Submission review uses the saved response rather than stale loaded content.
- Admin preparation reconciles registered and draft-only sources, preserves operator work and uncertain submissions, creates missing drafts transactionally, and exports identities, content, samples and image plans. Changed sources, duplicate counterparts and identity conflicts are blocked.
- Three-button image twins are distinct from ordinary twins. Registration retains capability; projections derive it from the text parent. Readiness checks approval, activation, synchronization, header, variables, body/footer and buttons against the actual selected sender.
- Shared-number sends preserve ordinary text/logo flows when off and use matching three-button text/logo variants when opted in and ready. Later degradation retains the established safe ordinary path and exposes a reason. Opted-in sends require an approved usable fallback even when ordinary guardrails are off; if no eligible fallback remains, the new send is withheld before claiming usage. A registered three-button text counterpart with a provider header is rejected as incompatible. Own-number sending remains independently approved text only, including merchants with configured logos.
- Initial, follow-up and reconfirmation selection share the same decision. Actual attempt identity is persisted before I/O, including bounded media fallback. Unknown outcomes, late receipts and accounting retain existing recovery rules.
- Settings and branding changes revalidate readiness. Counterparts cannot become ordinary defaults/replacements. Admin mutations retain staff/operator guards and transactional audit.

## Production milestone

Production supplied 23 text definitions and 23 ordinary image twins. Its automatic sync advanced timestamps during work without changing content/status; the snapshot and disposable test were refreshed before execution.

Original migration 0093 was applied under the migration advisory lock and recorded using its original LF-normalized hash. The operation stopped before 0094/0095. It prepared 23 drafts: Arabic 5, English 6, Urdu 3, Spanish 3, French 3 and Turkish 3. Every record remains draft without provider approval, activation or a registered counterpart. All 23 image twins remain plans.

An exact final comparison caught CRLF conversion inside SQL string literals. The generator now escapes literal line endings separately from source-file CRLF, covered by a byte-for-byte contract assertion. Only this run's fresh unchanged drafts were corrected under identity/state/timestamp/body guards. All 23 actual production drafts subsequently matched reviewed content byte-for-byte and passed the real authoring validator.

The existing 46 template rows, including mappings, content, defaults, activation and status metadata, retained fingerprint `a83801cf11a2c493c962aae333001ed5` before and after maintenance. All 15 pre-existing ordinary draft records also remain unchanged, excluding only the newly added null capability columns. No provider IDs/approval, new live twins, merchant provisioning, activation or deployment were fabricated or performed.

- [Readable review and manual Meta fallback](change-request-templates-production.md)
- [Exact content, parameter mappings, production draft IDs and verification metadata](change-request-templates-production.json)
- Source fixture: `test/fixtures/change-request-preparation/production-before.json`, containing system template definitions and synthetic authoring samples, not customer messages or credentials.

## Verification

- Backend full unit suite: 385 suites / 8,518 tests passed. Core boundary suite: 25 suites / 341 tests passed. Subsequent focused checks cover final controller, editor, logo and attempt-persistence changes.
- Frontend full suite: 194 files / 2,336 tests passed. Admin/message follow-up: 21 files / 209 tests passed.
- Disposable preparation contracts: five passed, covering exact content/counts, bounded history, concurrent/idempotent preservation, positional variables, twin identity and draft-only sources.
- Template registry/sync/authoring: 28 / 24 / 37 passed. Change-request messaging/reconfirmation: 25 / 13 passed. Integrated release/browser bridge: 37 passed. E04.5 billing contracts: 314 passed.
- Six new real-component browser cases cover all message languages, saved content and submission review, fixed third labels, predecessor/sample values, Arabic RTL/mobile/dark and submission counts. Downloads verify the review export. Provider transport is synthetic intercepted HTTP.
- Final follow-up: 109 backend tests and 89 frontend tests passed; six browser cases passed including review downloads. The messaging SQL test exercises tenant/generation/state fences, actual image/text snapshots, unchanged reservations and duplicate-acceptance accounting.
- Builds, TypeScript including separate smoke project, lint, touched formatting and structured logging are recorded in `.tmp/three-button-*`. Final results and Git delivery are in the existing CR05 handoff.
- Actual production preparation was verified through the database connector. Local mutations use disposable databases and fake providers. No fresh Meta approval, real delivery, deployed external authentication, native Shopify framing or production worker health is established.

## Operator sequence and rollback

1. Review the exports and drafts after delivering the verified application code. Migrations 0094/0095 remain later deployment prerequisites; draft preparation is not full feature release.
2. Validate and submit selected text drafts using existing operator actions. Reconcile uncertain submissions by exact name/language. Sync real results and activate usable counterparts without ordinary defaults.
3. Review matching image plans. Separately authorize Create missing twins, which uploads the neutral sample and submits to Meta. Sync and activate genuinely approved compatible twins. Continue using the existing runtime merchant banner.
4. Provision supported own-number text copies and obtain independent WABA approvals. Own-number image provisioning remains unsupported and does not block text opt-in.
5. Enable merchant opt-in only when the actual sender/language/style/header variant is ready. Observe readiness/fallback reasons after degradation.

Rollback disables future feature selection while retaining predecessors, branding, defaults, schema, handlers, consumers, open requests, valid already-sent buttons and dispatch history. Unsubmitted drafts may remain stored. Do not reverse schema or retire old templates to undo future selection.
