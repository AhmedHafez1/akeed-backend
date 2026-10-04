# US-07-01 WooCommerce contract and implementation plan evidence

**Validated:** 2026-10-04
**Revision:** backend working tree on `develop`, on top of `f144b54`. The frontend repository was not changed.
**Decision:** contract record written; verdict "US-07-02 to US-07-06 unblocked to build". The record waits for product-owner review before US-07-02 starts.

This story produced documents and fixtures only. No production code was written, no request was sent to any store, and no test store exists. The documentation pages listed below were read from the public internet.

## Decisions taken in the record (2026-10-04)

The seven product decisions in the [epic README](Epics/07-woocommerce-integration/README.md) are restated in the record with their numbers. Four more choices had to be made to write a complete contract. They are labelled "DECIDED (record)" and are the product owner's to confirm or change on review:

| Finding | Choice                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 4.12    | `processing` and `on-hold` are the statuses that count as placed. The documentation names only Processing for a COD order.          |
| 5.16    | An outcome is written only while the order is `processing` or `on-hold`. Every other status, including a custom one, is a conflict. |
| 5.17    | The marker is the meta key `akeed_outcome` with the value `<action>:<correlationId>`.                                               |
| 5.18    | The confirmation note is internal and has a fixed text. A cancellation adds no note of Akeed's own.                                 |

WooCommerce's merchant documentation (`woocommerce.com/document`) is treated as official documentation. It is the only place that states the status a COD order gets, what the Draft status is and that a cancellation returns stock. Each of those stays on the gate observation list.

## What was produced

- [Contract record](Epics/07-woocommerce-integration/evidence/US-07-01-contract-record.md): sources, eight sections of labelled findings with an empty VERIFIED column, the support boundary with codes and Arabic and English messages, the adapter boundary, a supported / unsupported / unknown table, eight gate observations, the verdict and the documentation discrepancies.
- [Fixtures](../test/fixtures/woocommerce/README.md): four order bodies and a ping, synthetic, marked "documented, not captured".
- Story status, the epic status line and the epic story table.
- One correction in the story text: issue #37958 was called open; it was closed as completed on 2026-09-25.

## Acceptance criteria

| AC  | Evidence                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The record exists at `evidence/US-07-01-contract-record.md`, dated, with the eight sections in the order the story lists. Every finding has a label; DOCUMENTED findings name their source page, all read on 2026-10-04; DECIDED findings name who and when. The VERIFIED column is empty. |
| 2   | 23 of the 104 findings are UNKNOWN. Each is covered by a rule in its section, either under "Worst-case rules" or in the rule the finding belongs to (the install reference for 1.8, the ping rule for 3.10, the status allow-list for 4.7, the marker-first write for 5.6).                |
| 3   | Section 5 states the mapping of epic decisions 2, 3 and 4 with side effects, the statuses a write is allowed from (5.16) and the conflict result for every other status.                                                                                                                   |
| 4   | Section 4 "The ingestion rule": both topics, the draft delivery (3.6 to 3.8), the start rule, the three idempotency keys, the routing table and the rule for an order older than the connection.                                                                                           |
| 5   | "Support boundary": what is supported, how each unsupported case is detected, its code, HTTP status and message in English and Arabic.                                                                                                                                                     |
| 6   | "Adapter boundary": spoke files, tables, registration points, the two shared changes, the five switches, and the restricted client's nine rules in section 8.                                                                                                                              |
| 7   | `test/fixtures/woocommerce/` holds the five fixtures and a README. The two undocumented parts (the draft status value, the ping body) are marked as assumptions.                                                                                                                           |
| 8   | The record ends with the supported / unsupported / unknown table, eight observations for US-07-06 and a verdict per story. No UNKNOWN on authenticity, tenant resolution or secret handling is left without a design that closes it; the verdict section says why for each.                |

## Test requirements

| Requirement                                              | Result                                                                                                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No runtime tests                                         | None were written or needed.                                                                                                                                                 |
| Every relative link in the record and the story resolves | Checked by script for the record, the story, the epic README, this file and the fixtures README. See below.                                                                  |
| The fixtures parse                                       | The four JSON files parse; `ping.txt` parses as `application/x-www-form-urlencoded`. That content type is an assumption: the ping body is documented nowhere (finding 3.10). |
| Record what was read and when                            | The record's Sources table: 11 documentation pages and one GitHub issue, all on 2026-10-04.                                                                                  |

## Validation results (as run, 2026-10-04)

Run from `akeed-backend` with node scripts kept outside the repository.

| Check                                                                                                          | Result                        |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Relative links in the five Markdown files                                                                      | 67 links, all resolve         |
| JSON fixtures parse and have `_fixture` and `payload`                                                          | 4 of 4                        |
| `ping.txt` parses as form-encoded                                                                              | 1 key, `webhook_id`           |
| Quoted text in the findings tables found in the saved copy of its source page                                  | 53 quoted passages, all found |
| Scan of the new files for key-like strings (`ck_`, `cs_`), non-example hosts, control and invisible characters | Clean                         |
| `npx prettier --check --end-of-line crlf` on the new files                                                     | Pass                          |
| Line endings of the two edited docs                                                                            | CRLF, unchanged               |

Not run, because no source file changed: `tsc`, `eslint`, `jest`, `npm run build`, `npm run log:check`, the contract suites and the release gates. Not done: any request to a WooCommerce store.

## Open items and known limits

- The record waits for product-owner review. The four "DECIDED (record)" choices above are the points most likely to change.
- Everything in the record is DOCUMENTED, DECIDED or UNKNOWN. Nothing is VERIFIED until the US-07-06 live run.
- A store connected while `WOOCOMMERCE_INGESTION_ENABLED` is off will have its webhooks disabled by WooCommerce after about five orders, because the delivery URL answers `404`. The record gives the rollout rule (section 3, "Consequences"). No story was changed for this.
- `CONNECT_SKIN` in the frontend's `useOnboardingSourceSkin.ts` is fixed to EasyOrders. US-07-02 has to resolve the connect skin from the source chosen at signup. The record notes it under "Adapter boundary".
- The top-level [epics index](Epics/README.md) still says E07 is Backlog in its status line. It was left alone: the story asks for the story status and the epic table only.
- The documentation contradicts itself in three places (failed-delivery definition, the disable threshold, the default webhook secret). The record lists them and follows the strictest reading.

## Operational notes

- Nothing is deployable from this story and no switch exists yet.
- If the build or the gate contradicts the record, the record is corrected first and one focused validation story is opened. This story is not reopened.
