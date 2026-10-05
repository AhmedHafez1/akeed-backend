# WhatsApp template reconciliation kit (US-08-01)

This kit produces the evidence for
[US-08-01](../../../docs/Epics/08-whatsapp-template-management/US-08-01-meta-contract-and-live-template-reconciliation.md).
It is not production code and nothing in `src/` depends on it.

The findings go into
`docs/Epics/08-whatsapp-template-management/evidence/US-08-01-contract-record.md`.

| Script                 | Calls Meta      | What it does                                                              |
| ---------------------- | --------------- | ------------------------------------------------------------------------- |
| `list-templates.mjs`   | Yes, `GET` only | Lists every template in the environment's WhatsApp Business Account       |
| `reconcile.mjs`        | No              | Compares a saved list with `src/shared/messaging/cod-template-catalog.ts` |
| `sanitize-fixture.mjs` | No              | Turns a saved list into a fixture with synthetic IDs                      |

## Rules

- `list-templates.mjs` is read-only. It sends `GET` requests to one Graph API edge, `/{WhatsApp Business Account ID}/message_templates`, and nothing else. It never creates, edits or deletes a template, never changes a webhook subscription and never sends a message.
- Credentials come from environment variables. Do not put them in a file in this repository, and do not paste them into a chat or into the results you hand back.
- Output goes to `.tmp/spikes/whatsapp-templates/<env>/`, which is gitignored. Never commit it.
- Dev and prod are separate Meta apps with separate accounts and templates. Run the script once for each, with that environment's variables.

## What the script needs

Two environment variables, and nothing else:

| Variable                 | What it is                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `WA_BUSINESS_ACCOUNT_ID` | The WhatsApp Business Account ID. It is **not** `WA_PHONE_NUMBER_ID`.                              |
| `WA_ACCESS_TOKEN`        | The token the app already sends with, if it has the permission below. Otherwise a token that does. |

`WA_BUSINESS_ACCOUNT_ID` is in `.env.example`, but the application does not read it today, so it may be empty in your `.env`. The ID is normally shown in the Meta app dashboard under **WhatsApp > API Setup**, next to the phone number ID, and in **Business settings > Accounts > WhatsApp accounts**.

**Token permission: `whatsapp_business_management`.** Meta requires it to read a WhatsApp Business Account's templates. `whatsapp_business_messaging`, which is all that sending needs, is not enough on its own. The token's system user must also have access to that WhatsApp Business Account; Meta's documentation says partial or full access both allow queries.

If the token lacks the permission, Meta answers with a permission error and the script says so. Nothing is changed either way.

## Run it

PowerShell, from `akeed-backend`:

```powershell
node --env-file=.env scripts/spikes/whatsapp-templates/list-templates.mjs --env dev
```

For prod, load the prod app's two variables instead and pass `--env prod`. For example, with a local env file that holds them:

```powershell
node --env-file=.env.production scripts/spikes/whatsapp-templates/list-templates.mjs --env prod
```

`--env` only names the output folder. The script cannot tell which app a token belongs to, so check the "account ending" digits it prints against the account you meant.

Prefer `--env-file` over typing `$env:WA_ACCESS_TOKEN = '...'`: PowerShell keeps typed commands in its history file.

The script prints, for each template, its name, language, status, category, quality and full components, and writes the same data to `.tmp/spikes/whatsapp-templates/<env>/templates.json`.

| Exit code | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| 0         | The list is complete and written                                                         |
| 1         | A variable or `--env` is missing; nothing was sent                                       |
| 2         | Meta refused or did not answer. The HTTP status, Meta's error code and message are shown |
| 3         | The token was found in an output file (this should not happen; delete the folder)        |
| 4         | More than 5,000 templates; the list is incomplete                                        |

On exit code 2 the script also writes `last-error.json` with the same three values.

## How to confirm it is read-only and leaks no secret

1. Run the self-test. It needs no credentials and uses no network. It runs the real code against a stub with a dummy token, including a response that echoes the token and a paging link that carries it, and fails if the dummy token is printed or written, or if any request is not a `GET`:

   ```powershell
   node scripts/spikes/whatsapp-templates/list-templates.mjs --self-test 1> "$env:TEMP\wa-selftest.out" 2> "$env:TEMP\wa-selftest.err"
   Get-Content "$env:TEMP\wa-selftest.out" -Tail 20
   Select-String -Path "$env:TEMP\wa-selftest.out", "$env:TEMP\wa-selftest.err", ".tmp\spikes\whatsapp-templates\self-test\*" -Pattern 'EAASELFTEST' -SimpleMatch
   ```

   The first command ends with `SELF-TEST PASS`. The last one prints nothing: `EAASELFTEST` is the start of the dummy token.

2. Read the request code. There is one call site, in `lib.mjs`:

   ```powershell
   Select-String -Path scripts\spikes\whatsapp-templates\*.mjs -Pattern 'POST|PUT|PATCH|DELETE|method:' -CaseSensitive
   ```

   It shows `method: 'GET'` in `lib.mjs` and the self-test's stub in `list-templates.mjs`, and no other HTTP method. The host and Graph version are a constant in `lib.mjs` with no override. The token goes in the `Authorization` header and is never part of a URL. Graph's `paging.next` link can carry the token, so the script never follows, stores or prints it.

3. After a real run the script checks every file in the output folder for the token and says so. The last line must read `the access token is not in them`.

4. Optional, against Meta: run once with a made-up token in the environment. It is a `GET` with an invalid token, so Meta answers with error code 190 and nothing else happens. The output must show the HTTP status, the code and Meta's message, and not the made-up token.

## Also needed for the record

**Variant usage (acceptance criterion 7).** Run this read-only query on each environment's database, for example in the Supabase SQL editor, and hand back the rows with the date. It returns counts only, with no organization or store names:

```sql
select
  default_language,
  cod_template_ar_variant,
  cod_template_en_variant,
  coalesce(is_active, false) as is_active,
  count(*) as integrations
from integrations
group by 1, 2, 3, 4
order by 1, 2, 3, 4;
```

**From the Meta dashboards**, for each app, write down:

- The webhook fields the app is subscribed to (**App dashboard > WhatsApp > Configuration**). Names only.
- The sender number's messaging limit and quality rating as WhatsApp Manager shows them.
- Whether the WhatsApp Business Account's business portfolio is verified. It decides the template limit.

## Reconcile and make the fixture

These read the saved run and call nothing:

```powershell
node scripts/spikes/whatsapp-templates/reconcile.mjs --env dev
node scripts/spikes/whatsapp-templates/reconcile.mjs --env dev --compare prod
node scripts/spikes/whatsapp-templates/sanitize-fixture.mjs --env dev --out test/fixtures/whatsapp-templates/template-list.json
```

`reconcile.mjs` writes `reconciliation.md` and `reconciliation.json` next to the run. For each of the 8 catalog variants it reports whether the template exists at Meta under that name and language, its status, category and quality, the parameter format and variables against what the code sends, any header or footer, the buttons against the payload order the code sends (index 0 is confirm, index 1 is cancel), and a word-level diff of the body against the catalog preview. It then lists Meta templates the catalog does not use and catalog entries missing at Meta. `--compare` adds a dev against prod table.

It imports the catalog as TypeScript, which needs Node 22.18 or newer. Node prints a `MODULE_TYPELESS_PACKAGE_JSON` warning for it; that is harmless.

`sanitize-fixture.mjs` replaces template IDs with synthetic ones and prints every string it kept, marking those that look like an identifier, a phone number, an address or a link. Read that list before committing the fixture.

## What to hand back

- Say that `.tmp/spikes/whatsapp-templates/dev/templates.json` (and `prod/templates.json`, if you ran prod) are ready. They are read from disk; do not paste them.
- The date of each run, and which app each one was (dev or prod).
- The variant usage rows for each environment.
- The dashboard notes above.
- If the script failed, the three lines it printed: HTTP status, Meta error code, Meta message.
