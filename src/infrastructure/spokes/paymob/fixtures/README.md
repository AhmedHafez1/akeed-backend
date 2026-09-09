# Paymob callback fixtures

These payloads drive the HMAC and status-mapper specs. They are **synthetic**:
Akeed's Paymob merchant account is not enabled yet, so no real callback has been
captured. Absent-versus-null handling and boolean serialization are provider
contract details we cannot invent our way to, so the specs are built to become a
real provider contract the moment a sandbox capture exists.

## Shape

```jsonc
{
  "provenance": "synthetic",   // or "sandbox-capture"
  "capturedAt": null,          // ISO timestamp of the capture
  "query": { "hmac": null },   // the digest Paymob actually sent
  "body": { "type": "TRANSACTION", "obj": { … } }
}
```

## How the specs use them

1. **Always.** `buildPaymobHmacSource` is compared against a reference
   implementation written out longhand inside the spec. Reordering
   `PAYMOB_HMAC_FIELDS` fails that comparison, so the documented order stays
   pinned whether or not a real digest exists.
2. **Only for `provenance: "sandbox-capture"`.** The fixture is verified against
   its own recorded `query.hmac` using `PAYMOB_FIXTURE_HMAC_SECRET`. Without
   that variable the block is skipped with a `NOT RUN:` message, matching the
   convention the database contract suites use.

## Replacing a fixture with a real capture

Keep the filename. Then:

1. Replace `body` with the callback verbatim — including fields we do not sign.
   Redact nothing except a raw card number, which Paymob does not send anyway.
2. Set `provenance` to `"sandbox-capture"` and `capturedAt` to the capture time.
3. Set `query.hmac` to the digest from the callback URL.
4. Export `PAYMOB_FIXTURE_HMAC_SECRET` with the sandbox HMAC secret and run
   `npm test`.

The specs must then pass **unchanged**. If they do not, the discrepancy is a
real difference between Paymob's contract and this implementation, and it must
be fixed in `paymob-hmac.ts` rather than by editing the capture.

Wallet callbacks in particular must be captured before Vodafone Cash traffic is
enabled: Paymob documents per-intention `notification_url` as card-only, so the
wallet integration's processed callback is configured in the dashboard and its
payload shape is unverified until it is seen.
