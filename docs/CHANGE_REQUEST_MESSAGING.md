# Customer change-request messaging

Change requests default to off. `PATCH /api/settings` and `PATCH /api/onboarding/settings` accept `changeRequestsEnabled` through the existing settings DTO. The owner/admin checks and tenant selection are unchanged. Settings state includes `changeRequestsEnabled` and `changeRequestReadiness` (`ready` and per-language/style/sender `variants`). A blocked activation returns `CHANGE_REQUEST_TEMPLATES_UNAVAILABLE` with readiness details. Settings changes while enabled are checked again.

The ordinary template selector excludes change-request versions. After normal language/style and sender selection, an opted-in send can use the exact approved three-button counterpart. Missing or unusable counterparts retain the ordinary two-button selection; they never cause another language/style or sender to be selected to obtain a third button. The dispatch snapshots its button capability, cycle and recipient digest. Disabling future use does not revoke already-sent valid buttons.

## Template preparation and approval

Migration `0093_change_request_messaging.sql` prepares drafts for every registered text confirmation/reminder variant, including draft-only supported languages. Each draft points to its predecessor through `change_request_of_key`. No existing definition, default, provider ID or approval is changed. Prepared content should be reviewed through the existing template-authoring workflow before submission. The draft view and neutral provider submission include the third button.

Use existing authorized staff template submission, reconciliation, sync and activation operations to provision the shared sender. Activate counterparts without making them ordinary language defaults or retiring their predecessors; selection stays controlled by merchant opt-in. Approval must come from actual provider metadata, with compatible variables and exactly three quick replies: Confirm, Cancel, Request a change. Arabic uses `طلب تعديل`. Once a shared version is approved and active, the existing merchant connection provisioner copies all three buttons and waits for independent approval in each merchant account. A merchant connection with pending, rejected, paused, drifted or non-utility copies is unavailable for three-button use. Image-header twins can be prepared through the existing image-twin workflow after the text version is approved; new three-button sends use their approved text version.

Provider requirements were checked against [Meta template components](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components.md): quick-reply labels allow 25 characters; button indexes define their order. A local definition is never evidence of approval.

## Incoming actions and acknowledgements

Versioned buttons carry the verification and confirmation cycle, and must quote their accepted outbound message. The receiving account/number, tenant, order, recipient digest and cycle are checked. Customer choices are serialized under the verification lock and ordered by provider timestamp, with event identity as the deterministic tie-breaker. Existing terminal-state protections remain. Legacy callbacks remain supported; messages without valid associations are not used to discover a merchant for this feature.

Opening a request commits its history and durable side effects before delivery. Only the customer acknowledgement effect is consumed here; merchant email and platform-marker effects remain for their own consumers. An acknowledgement uses fixed localized copy, the original confirmation dialect and sender, and store/order identifiers. It bypasses quiet hours independently of reminder and resend scheduling and independently of ordinary thank-you settings.

`change_acknowledgment` is a separate dispatch kind, scoped to the request's confirmation cycle. It consumes one message through existing sender-specific credit or plan accounting. No new price, ledger or Meta free allowance is introduced. Exhausted allowance permanently settles the effect as `skipped_no_allowance`; later top-ups do not revive it. Closed service windows skip the reply without a template fallback. Unknown provider outcomes are parked for existing reconciliation rather than blindly sent again. Receipts update billing and acknowledgement delivery state without changing the order outcome.

The existing verification-automation queue sweeps recoverable acknowledgement effects once per minute. Immediate handling runs after request capture; the sweep covers process/queue interruption. Both paths share the same effect lease and logical dispatch identity.

## Local verification and rollout

Run `scripts/test-change-request-messaging-contract.ps1` for synthetic PostgreSQL transport/billing contracts. It creates and removes its own database container and never reads application database configuration. Keep future three-button use off until the complete merchant handling, notification and synchronization workflow is ready. Disabling future selection is the rollback control; retain the schema and consumers needed by already-sent messages and open requests.
