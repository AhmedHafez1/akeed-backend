# US-08-08 — WhatsApp template release gate: evidence

- **Story:** [US-08-08 — Release gate](Epics/08-whatsapp-template-management/US-08-08-release-gate.md)
- **Date:** 2026-10-06

The evidence for this gate is kept with the epic, next to the contract record it depends on:

- [Release gate record](Epics/08-whatsapp-template-management/evidence/US-08-08-release-gate.md): commands, commits and outcomes, results per acceptance criterion, defects found, the open US-08-01 items, known limitations and the go/no-go recommendation per switch.
- [Live run script](Epics/08-whatsapp-template-management/evidence/US-08-08-live-run-script.md): the product owner's steps for dev and prod, with evidence slots and the reconciliation queries. Not run yet.
- [Support runbook](Epics/08-whatsapp-template-management/evidence/US-08-08-template-support-runbook.md).

One command runs the automated part: `npm run test:gate:e08` in `akeed-backend`.
