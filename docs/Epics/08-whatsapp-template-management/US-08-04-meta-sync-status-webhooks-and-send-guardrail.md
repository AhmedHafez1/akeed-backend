# US-08-04 — Meta sync, status webhooks and send guardrail

- **Epic:** [E08 — WhatsApp Template Management](README.md)
- **Delivery rank:** 4 of 8
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Feature
- **Status:** Implemented (2026-10-05), every switch off; waiting for the product owner to confirm the Meta webhook subscription before it is marked Done — [evidence](../../US-08-04-META-TEMPLATE-SYNC-EVIDENCE.md)
- **Dependencies:** [US-08-03](US-08-03-template-registry-and-send-path-cutover.md)

## User story and value

As Akeed staff, I want the registry to know what Meta currently says about each template, and sends to refuse templates Meta has not approved. I want to be told when a template in use becomes unusable. Then customers never get a message Meta will reject, and stores do not silently stop confirming orders.

**Business value:** closes the "nobody checks Meta" half of gap 2. It turns a paused or rejected template from a silent outage into a recorded fallback and a staff signal.

## Scope

- A scheduled sync and an on-demand admin sync from Meta into the registry snapshot.
- Webhook handling for template status, quality and category updates.
- A send guardrail with fallback and recorded reasons.
- Staff alerting through the existing admin health signals.

**Out of scope:**
- Creating or editing templates (US-08-06).
- Admin pages (US-08-05). This story exposes the API they use.
- Push, email or pager alerts unless open decision 2 adds one.
- Any change to customer-facing text.

## Acceptance criteria

1. **Port and adapter.**
   - The port is a neutral `TemplateCatalogPort` (name proposed) with `listTemplates()`. It returns neutral records: name, language code, review status, category, quality, components snapshot, provider template ID and last-updated time.
   - The Meta spoke implements it using the endpoints, permissions and status values in the US-08-01 contract record. No Meta status string, error code or component JSON leaves the spoke unmapped.
   - Unknown Meta values map to a neutral `unknown`, which is treated as not sendable.
2. **Sync.**
   - A BullMQ repeatable job and `POST /api/admin/templates/sync` (staff only, operator-gated as in US-08-06) pull every template from the environment's WhatsApp Business Account. They update the snapshot, status, category, quality and last-synced fields of matching registry rows (matched by Meta name and language code).
   - A template at Meta that has no registry row is reported, not created.
   - A registry row with no Meta template is marked `missing`.
   - The sync is idempotent, bounded by the rate limits in the record, and never logs the access token.
3. **Webhooks.**
   - The WhatsApp webhook accepts the template status, quality and category update fields named in the contract record, behind the existing `MetaWebhookSignatureGuard`.
   - Each update is stored with its event identity and time. An update older than the one already applied is ignored, and a duplicate is a no-op.
   - The existing `messages` and `statuses` handling is unchanged, and its tests pass untouched.
4. **Guardrail.** A template is sendable only when its registry row is active **and** its Meta status is the approved value in the contract record. On each send, for each language:
   - **Selected template sendable:** send it.
   - **Selected template not sendable, language default sendable:** send the default, and record the reason and the skipped key on the dispatch.
   - **Default also unavailable:** skip the send with the recorded reason `template_unavailable`. Usage is released as for any skipped send. Never fall back to the other language, and never guess a template.

   Whether paused and quality-flagged states are sendable follows the contract record. Where the record says UNKNOWN, the worst-case rule is "not sendable".
5. **Fresh environment.** The guardrail runs after sync has completed at least once. Until the environment has synced, behavior is decided by open decision 3. The decision and its switch are documented in [`docs/ENVIRONMENT.md`](../../ENVIRONMENT.md).
6. **Staff alerts.** When a template in use (selected by at least one active store, or a language default) becomes paused, disabled, rejected, missing or re-categorized, staff are alerted through the existing admin health signals:
   - a per-store signal (for example `template_unavailable`) in [`AdminHealthRuleService`](../../../src/modules/admin/admin-health-rule.service.ts) for every affected store;
   - a structured `buildBackendLog` alert line with an alert code, like the billing alerts.
7. **Configuration.**
   - `WA_BUSINESS_ACCOUNT_ID` becomes required at boot when template sync is enabled. `validateEnv` refuses to start without it, and the docs stop implying it is required otherwise.
   - New switches, default off: `WHATSAPP_TEMPLATE_SYNC_ENABLED` and `WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED` (names proposed).
8. **No customer-facing change while templates are approved.** With all templates approved, payloads stay byte-identical to the US-08-03 characterization suite.

## Open decisions (product owner)

All five were decided by the product owner on 2026-10-05, each as proposed: every 6 hours plus on demand; health signal plus a log alert, no email; before the first sync, send as today; when the default is also unavailable, skip and record without pausing automation; a re-categorization alerts and keeps sending.

Also decided on 2026-10-05:
- The contract record does not give the shape of `components` and `quality_score` in the list response. The adapter reads only the documented creation syntax and documented strings, and anything else is `unknown`. This is provisional until the US-08-01 live run.
- The dispatch columns stay columns. The suites that apply `0053` also apply `0056`, setup only, as US-08-02 did.


1. **Sync cadence.** The proposal is every 6 hours plus on demand, with webhooks as the primary signal.
2. **Alert channel.** Either per-store health signals plus a log alert only (proposal), or also an email to a staff address.
3. **Before the first sync.** When the guardrail is on but the environment has never synced:
   - (a) send as today, treating the seeded rows as approved (**proposal**);
   - (b) skip sends.
4. **Language default unavailable.** The rules say skip and record. Should Akeed also pause automation for the affected stores, so orders are not marked `no_reply` for a message that was never sent?
5. **Category changes.** Is a re-categorization (for example utility to marketing) only an alert, or also not sendable? It affects cost and delivery rules per the contract record.

## Implementation notes

- **Backend:**
  - The port goes in `src/shared/ports/`, the adapter in `src/infrastructure/spokes/meta/`, and the guardrail in the neutral selector from US-08-02 and US-08-03.
  - The webhook DTO today has no `field`, and the service reads only `value.messages` and `value.statuses` ([`whatsapp-webhook.dto.ts`](../../../src/infrastructure/spokes/meta/dto/whatsapp-webhook.dto.ts), [`whatsapp.webhook.service.ts`](../../../src/infrastructure/spokes/meta/whatsapp.webhook.service.ts)). Add a separate handler for template fields. Do not change the message path.
  - The sync queue uses its own BullMQ queue name.
- **Frontend:** None here. US-08-05 renders status and alerts.
- **Data:**
  - A migration adds the fields below, with a `_journal.json` entry and a rollback:
    - `template_status_events`, or event-identity and last-event-time columns on the registry;
    - dispatch columns `template_fallback_reason` and `template_skipped_key`.
  - The health signal needs a column or join exposing "store uses an unavailable template".
- **Operations:**
  - Subscribe the Meta app's webhook to the template fields named in the record, in both apps.
  - Document the switches, the new required variable and the alert codes in [`docs/ENVIRONMENT.md`](../../ENVIRONMENT.md) and [`docs/INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md`](../../INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md).

## Test requirements

- Adapter tests against a Meta template fake built from the contract record:
  - each status, category and quality value;
  - an unknown value;
  - pagination;
  - a rate-limit response;
  - an error response without the token in logs.
- Sync tests:
  - idempotent re-run;
  - a template unknown to the registry;
  - a registry row missing at Meta.
- Webhook tests:
  - each template field;
  - a duplicate delivery;
  - out-of-order delivery (older after newer);
  - an invalid signature, which is rejected by the existing guard;
  - `messages` and `statuses` handling unchanged.
- Guardrail tests:
  - selected approved;
  - selected paused, default approved, which falls back with a reason;
  - both unavailable, which skips with `template_unavailable` and releases usage;
  - never crosses language;
  - switch off behaves as today.
- Health signal tests for affected stores, and the alert log contains no template text or customer data.
- The characterization suite stays byte-identical. The E01, E04, E05, E06 and E07 regressions pass untouched.

## Migration and rollout

- Ship with both switches off.
- Enable sync first and compare the snapshot with the US-08-01 record in dev, then prod.
- Enable the guardrail last.
- **Rollback:** turn off `WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED` to restore today's sending. Turning off sync leaves the last snapshot in place.

## Evidence and references

**VERIFIED FROM CODE (2026-10-05):**
- No template fields are handled today.
- The signature guard is [`meta-webhook-signature.guard.ts`](../../../src/shared/guards/meta-webhook-signature.guard.ts) (HMAC-SHA256 with `META_APP_SECRET`, timing-safe).
- Health signals are SQL rules in [`admin-health-rule.service.ts`](../../../src/modules/admin/admin-health-rule.service.ts).
- Billing alerts are log lines (`standalone-billing-alert`) in [`billing-observability.service.ts`](../../../src/modules/admin/billing-observability.service.ts).
- `WA_BUSINESS_ACCOUNT_ID` is not in `META_VARS` in [`env-validation.ts`](../../../src/shared/config/env-validation.ts).

**ASSUMPTION / REQUIRES VALIDATION:** every Meta field name, status value, ordering key and limit used here comes from the US-08-01 contract record. This story names none of them as fact.

**EXTERNAL PLATFORM DEPENDENCY:** Meta template management API and template webhooks, as recorded in US-08-01. Both are proven live in US-08-08.
