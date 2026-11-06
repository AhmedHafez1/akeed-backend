# Merchant own WhatsApp number support

Use this runbook for an organization's connected WhatsApp Business number. The merchant's current connection readiness and the sender of a past accepted message are separate facts. Check Settings and the staff connection view before diagnosing a historical send. A reminder resolves its sender again and can use a different number from the initial confirmation.

## First checks

1. Identify the organization and affected verification or dispatch ID. Collect timestamps, connection state, setup step/error, selected template key/language, recorded sender/reason, billing pool/cost, and delivery state. Never collect a business token, PIN, customer message body, or raw webhook payload in a ticket.
2. Check `GET /api/whatsapp-sender` and `GET /api/whatsapp-sender/connection` through the authorized application. The staff view adds per-template setup and drift facts. A visible historical merchant sender does not establish that the connection is healthy now.
3. Check the global connect and sending settings through the owner's configuration workflow. They apply to every organization; monitoring stages do not restrict who can connect. The connect switch controls signup. The sending switch controls new own-number sends and stops already-claimed merchant retries before provider HTTP.
4. Confirm the exact selected text template is approved as UTILITY on this connection. An approved template on Akeed's account, a different language, or an image template is not sufficient. Setup copies live text templates, and connection template state is refreshed by webhooks and background sync.

For configuration prerequisites and durable webhook operation, see [Environment](ENVIRONMENT.md#merchant-own-whatsapp-number) and [Integrations and automation](INTEGRATIONS_WEBHOOKS_AND_AUTOMATION.md). For Akeed's shared template operations, see [Template support](WHATSAPP_TEMPLATE_SUPPORT_RUNBOOK.md); merchant-number templates that change to MARKETING are treated as unavailable for that sender.

## Connection and setup problems

Only an organization owner can connect, disconnect, or change the thank-you preference. Viewers and other members can inspect the allowed read-only state. Start signup from Settings; do not reuse or forward a ticket URL.

| Symptom or code | Action |
| --- | --- |
| `WHATSAPP_CONNECT_UNAVAILABLE` | Check the connect switch and required configuration. Keep sending disabled until operational readiness is established. |
| `WHATSAPP_CONNECTION_OWNER_REQUIRED` | Ask the organization owner to perform the change. |
| `WHATSAPP_CONNECT_TICKET_INVALID`, `WHATSAPP_SIGNUP_CODE_REJECTED` | Start a fresh connection from Settings and finish the new Meta flow. Do not replay the old link or code. |
| `WHATSAPP_NUMBER_ALREADY_CONNECTED`, `WHATSAPP_ACCOUNT_ALREADY_CONNECTED`, `WHATSAPP_CONNECTION_EXISTS` | Confirm the intended organization and its existing connection. Never transfer ownership by editing database IDs. |
| `WHATSAPP_SIGNUP_TOKEN_UNVERIFIED`, `WHATSAPP_SIGNUP_ASSET_UNVERIFIED`, `WHATSAPP_SIGNUP_ASSET_AMBIGUOUS` | Have the owner select the intended business/account/number and grant the requested access. Escalate a repeat mismatch with IDs and coded errors only. |
| `WHATSAPP_SIGNUP_PROVIDER_UNAVAILABLE` | Retry with a fresh Settings flow after provider recovery. |
| `credentials_unreadable`, `pin_unreadable`, `templates_credentials` | Check encryption/configuration health without opening encrypted values; reconnect through the owner if access must be renewed. Escalate deployment/key issues rather than replacing keys or ciphertext manually. |
| `subscription_unavailable`, `number_unavailable`, `templates_unavailable` | Inspect the recorded retry time and worker health. The durable setup row resumes work; do not repeatedly launch a replacement signup. |
| `subscription_rejected`, `number_rejected`, `number_not_in_account` | Check the selected account and granted access. Escalate persistent provider rejection; reconnect if access changed. |
| `path_mismatch`, `path_unverified` | The observed number path does not prove the signup path. Do not force activation. Capture the code and ask engineering to inspect the provider contract with synthetic reproduction. |
| `register_unresolved`, `register_rejected`, `register_rate_limited` | Do not repeatedly register the number. Preserve the recorded retry/block time and existing PIN; investigate the uncertain outcome or provider restriction. Coexistence setup does not call registration. |
| `connecting` or `verifying` persists | Check due setup/health jobs, their leases, template readiness, and coded errors. Completing signup alone does not make a connection active. |

## Sender reasons and failed sends

The first failed readiness check determines the reason. These normal shared-number choices are distinct from a fallback generation created after a merchant-number attempt failed.

| Recorded reason | Meaning and support action |
| --- | --- |
| `own_number` | Merchant sender selected. Inspect its persisted delivery state before claiming success. |
| `feature_off` | Sending switch is off; Akeed is the selected sender. Confirm whether this is the intended rollout or rollback. |
| `no_connection` | No connection exists; offer owner signup when available. |
| `not_ready` | Setup or verification is incomplete. Inspect setup, health, and template state. |
| `disconnected` | Connection was removed. Follow the disconnect/reconnect section. |
| `offboarded` | Provider offboarded the connection; inspect the lifecycle reason and reconnect after recovery. |
| `degraded:credentials` | Access is unusable; reconnect or resolve the deployment credential issue. |
| `degraded:payment` | Merchant should resolve payment in [WhatsApp Manager](https://business.facebook.com/wa/manage/). Akeed credits do not pay Meta's charges. |
| `degraded:restricted` | Resolve the account/number restriction with Meta. Do not force the connection active. |
| `template_missing`, `template_pending` | Wait for provisioning/approval of the exact template and language. |
| `template_rejected`, `template_paused` | Review that template's state in WhatsApp Manager and the connection template view. Other ready templates can remain usable. |
| `template_recategorized` | The approved template is no longer UTILITY; arrange a compliant utility replacement. |
| `send_failed:<code>` | A merchant attempt failed; inspect the neutral failure class and the linked fallback dispatch. The code table below determines the response. |
| `outcome_unknown`, `send_failed:outcome_unknown` | The original provider answer was uncertain. Its charge is returned before a linked Akeed fallback. A rare duplicate remains possible; reconcile both attempts and charge only the fallback. |
| Unrecognized or historical reason | Preserve the record and escalate. Do not infer a zero cost or successful delivery from missing historical fields. |

| Failure class | Codes or condition | Behavior and response |
| --- | --- | --- |
| Recipient | `131026`, `131021`, `131050`, `131049` | No sender fallback. Changing the sender would not resolve the recipient problem. |
| Retryable | `1`, `2`, `4`, `80007`, `130429`, `131000`, `131016`, `131056`, `131057`, `133004` | Up to two durable retries, approximately 30 seconds and two minutes apart, then fallback. Do not manually resend during recovery. |
| Credentials | `0`, `3`, `10`, `190`, `200`, `131005`, `sender_credentials_unavailable` | Fall back, degrade credentials, and restore access through the owner. |
| Payment | `131042` | Fall back and ask the owner to resolve payment in WhatsApp Manager. |
| Restricted | `368`, `131031`, `131045`, `131048`, `133010`, `131037` | Fall back and resolve the restriction with Meta. |
| Template | `132001`, `132007`, `132015`, `132016` | Fall back; the affected template is marked unavailable. Check the exact connection/template/language. |
| Payload | `100`, `131008`, `131009`, `132000`, `132005`, `132012`, `135000` | Fall back and escalate to engineering. Do not ask the merchant to repair Akeed's payload. |
| Unknown outcome | Transport failure, provider 5xx, or missing message ID | Return the original charge and authorize one linked fallback. Keep late acceptance as audit evidence. |
| Other/local unknown | Other codes or local sender failure | Fall back and investigate with coded, redacted evidence. |

A recovery job rechecks the verification: an answered/closed order must not receive another recovery send. A failed shared-number fallback follows normal Akeed settlement; it does not authorize an endless fallback chain.

## Disconnect, reconnect and thank-yous

For a local disconnect, the owner uses Settings. Akeed commits the disconnect and clears credentials first, then attempts provider subscription cleanup once. `providerCleanup: manual_required` means the local disconnect succeeded but the owner still needs to remove the provider link. Do not treat cleanup failure as a reason to restore credentials.

For a Coexistence connection, show the returned phone-app steps: **Settings → Account → Business Platform → Disconnect**. After the owner has completed removal and resolved the underlying issue, start a fresh Settings signup. Reconnect creates a new connection generation; old setup, health and retry jobs cannot activate or send through the replacement generation.

`PARTNER_REMOVED`, `PARTNER_APP_UNINSTALLED` and `ACCOUNT_DELETED` disconnect and clear credentials. `ACCOUNT_OFFBOARDED` offboards; `ACCOUNT_RECONNECTED` returns to verification before activation. Restriction/violation events degrade the connection. If the recorded reason is `PRIMARY_INACTIVITY`, ask the owner to open the WhatsApp Business app regularly and reconnect if required. Other provider reasons are preserved as identifiers for diagnosis.

Own-number thank-yous follow the connection preference and require an open service window and a healthy active receiving connection. They use no Akeed credits or plan capacity. They never fall back to Akeed and stop when own-number sending is disabled. Meta may charge the merchant separately under its pricing.

## Billing reconciliation

Prepaid dispatch costs are displayed credits: own number 1, Akeed 2. A fallback charges up to 2 from what remains, including 1 or 0 without debt. Ledger quantities and reservation quantities remain stored credits worth two displayed credits each. An own-number pack is shared across two one-credit charges, so a valid spare-funded dispatch may have no individual ledger entry.

Shopify charges the recorded pool, not the sender's identity: a healthy own-number send can use the Akeed pool for 1. An Akeed fallback uses 1 from the Akeed pool, otherwise up to 3 from the own-number pool, including a partial or zero charge. Plan changes reset both pools. Meta bills the merchant directly for its own-number traffic, separately from Akeed.

The owner/operator runs the read-only script using a dedicated database session and the pilot's organization and start time:

```powershell
psql "$env:PILOT_DATABASE_URL" -X -qAt -v org_id='<organization UUID>' `
  -v pilot_start='<ISO timestamp with timezone>' `
  -f scripts/own-number-pilot-reconcile.sql
```

The script never selects credentials or customer content into its output. It uses a consistent read-only snapshot and reports IDs and aggregates. Exit **0** means no detected contradiction. Exit **3** means a contradiction, invalid/missing input, or SQL failure; inspect the JSON report when present. An empty pilot is not delivery evidence. Historical missing snapshots are reported separately; account/ledger/spare checks use lifetime evidence so an opening pack outside the pilot is not lost.

Review `violations`, `confirmedDuplicateGroups`, and `expectedDuplicateRisks`. Duplicate checks group by verification and message kind and exclude confirmed failed attempts; a reminder is not a duplicate initial message. A possible duplicate is an uncertain merchant attempt followed by an accepted fallback. A confirmed duplicate has two recorded physical acceptances. The exception requires the original unknown-outcome record, returned charge and linked fallback; an exception does not prove which messages the customer received. Persisted plan counters are informational because historical dispatch totals cannot reconstruct a reset without an opening baseline.

For any contradiction, preserve the redacted report, organization/dispatch IDs and run timestamp, pause promotion, and escalate. Never repair balances, replay provider requests, or change dispatch snapshots from this runbook.

## Sending kill switch and operational checks

The owner disables `WHATSAPP_OWN_NUMBER_SENDING_ENABLED` through the deployment/configuration workflow and applies it to API and worker processes. Verify the observed sender reason is `feature_off` for a new synthetic or owner-authorized test. New confirmations resolve to Akeed at normal cost; own-number retries stop before HTTP and own-number thank-yous stop. Connections, preferences and balances remain intact. Already accepted provider messages cannot be recalled.

Do not disable durable Meta processing as a substitute for the sender kill switch: lifecycle and late delivery events must continue to reconcile while sending is off. To close new signups separately, disable `WHATSAPP_OWN_NUMBER_CONNECT_ENABLED`. Keep public pricing promotion disabled until the owner authorizes it; it is a separate frontend build-time setting.

Run `npm run test:gate:e09` locally only when owner dev servers are stopped. It uses synthetic providers, disposable databases and inherited release checks, including builds. `npm run test:gate:e09 -- -OwnOnly` is an iteration result; `PARTIAL_PASS` is not a complete release pass. Reports contain commands, outcomes, timestamps, commit IDs and fingerprints of non-secret tracked/untracked sources. Existing failed checks remain release blockers. Reconciliation on production and live WhatsApp tests are operator actions, separate from local fixture success.
