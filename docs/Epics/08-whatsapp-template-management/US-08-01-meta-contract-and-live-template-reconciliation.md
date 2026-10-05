# US-08-01 — Meta contract and live template reconciliation

- **Epic:** [E08 — WhatsApp Template Management](README.md)
- **Delivery rank:** 1 of 8
- **Priority:** P0
- **Horizon:** NEXT
- **Story type:** Contract and plan
- **Status:** Backlog
- **Dependencies:** [US-02-07](../02-platform-boundaries-and-reliability/US-02-07-platform-boundary-release-gate.md) (messaging port and dispatch ledger on `develop`)

## User story and value

As the product owner, I want Meta's template rules and the actual templates in each Akeed WhatsApp account written down and compared with the code, so that every later E08 story is built against observed behavior, not memory.

**Business value:** this story answers the open questions about the live templates: category, approval status, quality, the registered text, and any header or footer. Later stories stop guessing about the one provider every Akeed message depends on.

## Scope

- A read-only reconciliation script.
- A dated contract record at `evidence/US-08-01-contract-record.md`.
- A per-variant diff of the live text in Meta against the code catalog, for dev and for prod.
- A count of stores per selected variant.
- No production code and no change to any template.

**Out of scope:**
- Creating, editing or deleting a Meta template.
- Changing webhook subscriptions.
- Sending a message.
- Any registry, migration or admin UI.

## Acceptance criteria

1. **Read-only script.** `scripts/spikes/whatsapp-templates/` holds a read-only script and a README. The script lists every template in the WhatsApp Business Account of the environment it runs in. For each template it prints the name, language, status, category, quality and full components.
   - It reads `WA_BUSINESS_ACCOUNT_ID` and `WA_ACCESS_TOKEN` from the current `.env`, and nothing else.
   - It makes GET requests only.
   - It writes its output under `.tmp/spikes/whatsapp-templates/<env>/`. That folder is git-ignored and never committed.
2. **Secrets.** The script never prints, logs or writes the access token or app secret. An error report names only the HTTP status and Meta's error code and message. The README states how to confirm this.
3. **Runs and sources.** The contract record states which environment(s) the script ran against, the date, the Graph API version, the app (dev or prod, never its secret) and the script commit.
4. **Labelled findings.** Each finding is labelled VERIFIED (observed in a dated run on the Akeed dev or prod app), DOCUMENTED (Meta documentation, with URL and read date) or UNKNOWN. Each UNKNOWN carries a worst-case rule later stories must follow. The record covers:
   - **Endpoints:** list, create, edit and delete template endpoints, and the permissions and token type each needs.
   - **Review:** the review lifecycle and every status value.
   - **Editing:** edit limits on approved templates (how often, which parts, whether an edit triggers re-review, and whether sending continues during it).
   - **Fixed attributes:** whether a template's name, language or category can change after creation.
   - **Categories:** category rules and automatic re-categorization, including how Akeed is told.
   - **Parameters:** named versus positional parameters, the sample values required on create, and how the send payload must match.
   - **Buttons:** quick-reply button limits (count, label length, payload length).
   - **Webhooks:** the fields and payloads for template status, quality and category updates, including which webhook fields must be subscribed and whether event ids or timestamps allow ordering and de-duplication.
   - **Rate limits:** for the template management API and for sends.
   - **Free-form messages:** the rules for free-form (non-template) messages inside the customer service window, including what opens the window and how long it lasts.
5. **Live account facts.** The record lists, for every template and language in each environment:
   - status, category and quality;
   - header, footer or other components the code does not send;
   - whether the oddly named templates (`_akeed_cod_verification_professional`, `akeed_cod_verification_direct_`) are what is live;
   - whether dev and prod hold the same templates.
6. **Text diff.** The record ends with a diff for all 8 code variants, per environment, of live Meta text against [`cod-template-catalog.ts`](../../../src/shared/messaging/cod-template-catalog.ts). It covers:
   - body text, word for word, with variables marked;
   - button labels and order;
   - parameter format and parameter names or positions;
   - language code.

   It also lists the preview blocks that do not match Meta, such as the repeated total in the Arabic variants and order text in `totalLabel`.
7. **Variant usage.** The record includes a dated count of integrations by `cod_template_ar_variant`, `cod_template_en_variant` and `default_language`, per environment. It is taken with a read-only query and contains no organization names.
8. **Verdict.** A verdict lists which later stories may be built. It also lists the UNKNOWNs that block go-live and must be turned into VERIFIED by US-08-08.

## Open decisions (product owner)

1. Run the script on prod in this story, or on dev only now and on prod at US-08-08. The recommendation is both now: it is read-only, and the variant usage count matters for retire decisions.
2. Who runs the script with the prod token. The token is never shared through this repository or a chat.
3. Whether the legacy names with a leading or trailing underscore are kept for good or replaced later through US-08-06. This story only records them.
4. If dev and prod hold different text for the same name, which one is the baseline for the US-08-03 characterization test. The proposal is the code payload, since that is what is sent today.

## Implementation notes

- **Backend:** The script is plain Node or TypeScript under `scripts/spikes/whatsapp-templates/`, like the [EasyOrders spike kit](../../../scripts/spikes/easyorders/README.md). It is not a Nest module and does not import application services. It pins the Graph API version used by [`whatsapp.service.ts`](../../../src/infrastructure/spokes/meta/whatsapp.service.ts) (v24.0 today) and states it in its output.
- **Frontend:** None.
- **Data:**
  - The variant count is a read-only SQL query in the script README, run by the product owner or an operator.
  - Fixtures saved later for US-08-08 use synthetic IDs and contain no token.
- **Operations:**
  - Dev and prod are separate Meta apps; the README says to run once per environment's `.env`.
  - Each deployment's `WA_*` variables point at that environment's app.
  - Note in the record that `WA_BUSINESS_ACCOUNT_ID` is unused by the application today and that [`docs/ENVIRONMENT.md`](../../ENVIRONMENT.md) lists it as if required. US-08-04 makes it required when sync is enabled.

## Test requirements

- No runtime tests: this story produces a script, a record and a diff.
- Each relative link in the record and story resolves.
- A dry run with a dummy token shows that no token value reaches stdout, stderr or `.tmp` output.
- Satisfy the applicable [shared Definition of Done](../README.md#shared-definition-of-done). Record what was run and read, and when.

## Migration and rollout

There are no migrations. US-08-02 starts when the verdict says it may. A finding contradicted later updates the record and reopens only the affected story.

## Evidence and references

**VERIFIED FROM CODE (2026-10-05):**
- The only Graph call is `POST /v24.0/<phone-number-id>/messages` in [`whatsapp.service.ts`](../../../src/infrastructure/spokes/meta/whatsapp.service.ts).
- No `message_templates` call exists, and `WA_BUSINESS_ACCOUNT_ID` is not read by any code.
- The WhatsApp webhook handles only `messages` and `statuses` ([`whatsapp.webhook.service.ts`](../../../src/infrastructure/spokes/meta/whatsapp.webhook.service.ts)).
- [`docs/ENVIRONMENT.md`](../../ENVIRONMENT.md) says the Meta app must subscribe to the `messages` field.

**ASSUMPTION / REQUIRES VALIDATION:**
- That templates are created by hand in WhatsApp Manager.
- That the registered text matches the code preview.
- That no header or footer exists.
- That dev and prod hold the same set of templates.

**EXTERNAL PLATFORM DEPENDENCY:** Meta WhatsApp Business Platform documentation. These are inputs for this story only and are restated with labels in the record:
- [Meta — Message templates](https://www.postman.com/meta/whatsapp-business-platform/folder/2l70wum/message-templates)
- [Meta — Webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference)
- [Meta — WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
