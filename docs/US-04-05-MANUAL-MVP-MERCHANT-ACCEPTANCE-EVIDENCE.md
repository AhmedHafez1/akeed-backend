# US-04-05 — Standalone merchant acceptance evidence

**Evidence date:** 2026-09-05  
**Decision:** Implemented locally — release blocked  
**Backend HEAD:** `99373ad` (working tree contains the US-04-04 and US-04-05 changes)  
**Frontend HEAD:** `07ad8f7` (working tree contains the US-04-04 and select-layout changes)

This record deliberately separates local implementation evidence from target-environment release evidence. No production migration, tenant repair, credential capture, or unapproved provider action was performed.

## Results

| Gate | Result | Evidence / limitation |
| --- | --- | --- |
| Composed Standalone acceptance harness | PASS | `npm run test:acceptance:e04`: 1 suite, 6 tests. Covers test send, manual COD acceptance, worker processing, customer confirmation and duplicate callback, Redis/dispatch recovery, invalid phone, viewer denial, inactive source, revoked session, non-COD ineligible, provider uncertainty, concurrent idempotency, changed replay conflict, forged source IDs, and cross-tenant retry denial. |
| Shopify isolation sentinel | PASS | The composed harness wires a Standalone adapter and a Shopify sentinel; the happy-path confirmation completed with zero Shopify calls. |
| Backend build | PASS | `npm run build`. |
| Backend non-fixing lint | PASS | `npx eslint "{src,apps,libs,test}/**/*.ts"`; 0 errors and 19 pre-existing unsafe-argument warnings. |
| Frontend application typecheck | PASS | `npx next typegen` and `npx tsc --noEmit --pretty false`. |
| Frontend isolated fixture typecheck | PASS | `npm run smoke:e02:typecheck`. |
| Frontend lint | PASS | `npm run lint`. |
| Frontend isolated production build | PASS | `NEXT_DIST_DIR=.next/e04-validation-build npm run build`; generated type paths were removed from `tsconfig.json` after the check. |