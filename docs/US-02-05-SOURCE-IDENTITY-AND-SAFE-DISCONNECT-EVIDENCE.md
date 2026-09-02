# US-02-05 source identity and safe disconnect evidence

**Validated:** 2026-09-02  
**Revision:** working tree; not committed  
**Scope:** source-scoped order identity, trusted queued source identity, history-preserving disconnect, explicit privacy deletion, migration preflight, and disconnected dashboard state

## Acceptance evidence

1. Order deduplication now queries by `orgId + integrationId + externalOrderId`. Database ownership is enforced with composite source/organization foreign keys for orders, usage, webhook events and lifecycle rows, plus an order/organization relationship for verifications.
2. The isolated PostgreSQL contract inserts the same external ID for two sources in one organization and a third source in another organization. Each exact source resolves only its own order; a forged organization/source pairing resolves nothing and cannot be inserted.
3. Shopify uninstall continues to update the integration in one transaction: it sets `isActive = false`, clears access/webhook credentials and expiration, cancels billing, and closes the active lifecycle. It does not delete the integration. Webhook jobs carry the trusted source captured at ingestion and are skipped before normalization when that source is missing, mismatched or inactive. Automation sends and commerce outcomes retain their existing execution-time active/entitlement checks. Dashboard history remains organization-scoped and now reports the historical source as `disconnected`, with automation off and an Arabic/English banner in both UI modes.
4. Migration `0024_source_identity_and_history_retention.sql` repairs only rows whose organization has exactly one candidate source. It aborts on orphaned, ambiguous or mismatched ownership. Normal foreign keys no longer cascade integration deletion into order, verification, usage or webhook history. The explicit Shopify `shop/redact` path still deletes those child records before integrations and organizations; the PostgreSQL contract rehearses that sequence separately from disconnect.

## Migration preflight and exception handling

Run the read-only report against the target database before the migration and retain its output with the release evidence:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f scripts/preflight-source-identity.sql
```

- `orders_ambiguous_source`, `orders_orphaned_source`, and every `*_mismatch` must be zero before release.
- `orders_missing_source` may be non-zero only when every listed row has exactly one candidate integration. Migration `0024` backfills only those exact single-candidate rows.
- `webhook_partial_source_identity` may be non-zero only when the detailed report proves one exact source: an existing integration determines its organization, or an organization has exactly one candidate integration. The migration repairs only those cases.
- Do not choose a source for rows with zero or multiple candidates. Export the exception rows, investigate source evidence, and stop the rollout until ownership is resolved.
- Take the normal database snapshot before applying the migration. Do not run mass reassignment SQL.

During deployment, pause webhook and verification-automation consumers, deploy producer and consumer code, apply `0024`, then resume consumers. Jobs produced before this version have no pinned source fields and are deliberately marked `missing_source_identity` rather than executed.

## Rollback and recovery

- Prefer an application rollback while leaving the additive uniqueness, ownership and `NOT NULL` protections in place; the previous application schema remains compatible with them.
- Pause consumers before rolling application versions so mixed versions cannot process unpinned work. Resume only after producer and consumer versions match.
- Do not restore cascading integration deletes. If a database constraint must be disabled for an emergency, replace the composite foreign key with a non-cascading single-column foreign key, preserve all rows, and rerun the preflight before reinstating the composite constraint.
- If the migration aborts, no ambiguous/orphaned ownership is guessed. Preserve the preflight output and repair only evidence-backed rows before retrying.
- Authorized privacy redaction remains the existing signed `shop/redact` workflow; normal disconnect must never invoke repository deletion methods.

## Verification results

Run from `akeed-backend` unless noted:

| Check | Result |
| --- | --- |
| `npm test -- --runInBand` | PASS — 43 suites, 470 tests |
| `./scripts/test-source-identity-contract.ps1` | PASS — disposable PostgreSQL 17, 1 contract test |
| `./scripts/test-shopify-contract.ps1` | PASS — disposable PostgreSQL 17, 6 contract tests |
| `npm run build` | PASS |
| `npx eslint "{src,apps,libs,test}/**/*.ts"` | PASS with 19 existing test `any` warnings and no errors |
| Targeted Prettier check for changed backend files | PASS |
| Frontend `npx tsc --noEmit` | PASS |
| Frontend `npm run lint` | PASS |
| Frontend `npm run build` | PASS — 19 static/dynamic routes generated |

The contract wrappers use only a disposable, randomly published local PostgreSQL container and synthetic fixture data, restore the previous test URL, and remove only the container ID they created.

## Remaining release validation

- Run the read-only preflight and migration against the dedicated staging/contract database with retained counts.
- Smoke the disconnected banner with authenticated Shopify embedded and Standalone sessions in both Arabic/RTL and English/LTR. Local typecheck, lint and production rendering are complete; no live source was disconnected during this implementation.
