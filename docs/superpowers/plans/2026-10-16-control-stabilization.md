# Control Cloud Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Track results below and in the execution ledger.

**Goal:** Correct reviewed data-loss/financial/UI bugs, enforce shared viewer versus admin permissions, add linked shipment follow-up, and deliver recoverable staged releases.

**Architecture:** Preserve the existing Node HTTP and HTML app, extracting small pure modules for authorization, identity/workflow and backup integrity. Parent owns api-server.js integration; independent workers own Odoo libraries, HTML pages and backup/release tools.

**Tech Stack:** Node 22, CommonJS/ESM, HTML/React, Docker Compose/Traefik, Odoo 18 JSON-RPC, Git/GitHub Actions.

**Spec:** ../specs/2026-10-16-control-stabilization-design.md

## Global Constraints

- Odoo is read-only; company IDs remain 1 and 2; email remains disabled.
- Preserve runtime data and the owner's existing admin credential; provision separate shared viewer access privately.
- No real business writes for tests; staging gets separate data and no public production router.
- No secrets, runtime JSON/JSONL or backups in Git/images. Preserve unrelated repository content and working-tree edits.
- User approved execution of the previous review; implementation proceeds within that scope without another plan approval round.

## Review Focus

- Viewer/forged username cannot reach any mutation, including legacy and uncommon routes.
- A stale tab, newly created record, missing revision and failed disk write cannot acknowledge or overwrite unsaved business changes silently.
- Same-name documents in two companies/currencies, refunds, discounts and missing rates remain scoped and reconcilable.
- Board outage/bill retry/reopen retains provenance and visible failure; payload enforcement cannot violate geometry or unconstrained capacity.
- Backup tamper/traversal/partial writes and staged release failure must preserve production data and return to the previous image.

## Task 1 Persistence, permissions and linked workflow

Files: api-server.js, lib/users.cjs, lib/authorization.cjs, lib/shipment-identity.cjs, lib/import-workflow.cjs, lib/worklist.js, manage-users.mjs, tests/persistence-permissions.cjs, tests/import-workflow.cjs.

Produces GET /api/me {ok,user,role,canWrite}; tracking records retain _ts as server revision and gain immutable _shipmentId/parent PO links, owner/dueDate/checklist fields; write requests carry _baseTs; quote writes carry loaded updatedAt or revision. GET /api/worklist exposes daily tasks without mutation.

- [x] Preserve existing source as a baseline commit on a codex branch, excluding all secrets/runtime data.
- [x] Add failing isolated tests for legacy replace-all rejection, exact shared username, viewer GET/POST rules, fail-closed accounts, stale writes, missing interactive bases, invalid JSON and failed disk persistence.
- [x] Implement minimal fixes; keep scanner fill-empty paths explicitly scoped and compatibility-tested.
- [x] Add failing tests for stable/idempotent shipment identity, parent/split links, safe checklist parsing, responsible person/due date and no invented completion/quantities; implement additive model/worklist.
- [x] Run regression suites and isolated HTTP smoke; record result and commit only task files after integration.

## Task 2 Odoo scope and monetary correctness

Files: lib/odoo-boards.cjs, lib/odoo-services.cjs, odoo-queries.js, adapter tests. Parent integrates corresponding api-server.js SQL/routes/cost classification.

Consumes company/record-scoped PO detail inputs and existing adapter interfaces. Produces corrected FX matching and scoped details, with explicit unknown-rate behavior at the HTTP classification boundary.

- [x] Write failing tests for cross-company/wrong-direction/currency FX; same-name company-scoped PO detail.
- [x] Implement fixes in API and shared SQL; provide exact parent SQL integration changes.
- [x] Parent adds failing classifier tests for signed discount/refund reconciliation and unknown foreign rate, then fixes classification.
- [x] Run adapter/classifier tests, compare selected real example POs read-only, independent review and commit.

## Task 3 HTML and loading behavior

Files: import-export-os.html, freight-comparison.html, container-loading-calculator.html, tests/frontend-regressions.cjs, tests/loading-weight.cjs and existing packing tests as needed.

Consumes GET /api/me permissions, _ts/_baseTs tracking contract, additive shipment owner/due/checklist metadata and scoped PO detail. UI must retain the original loaded revision and selected bill references.

- [x] Add failing fixtures for ordinary stale edits, JSON ok=false, conflict reload, partial board outage, bill retry target and selected bill persistence.
- [x] Implement fixes and permission-based read-only controls; show persistent shipment identity/PO link and admin owner/due/checklist fields.
- [x] Add payload/pallet/item weight failing cases, implement safe fit/recommendation and split behavior while retaining geometry.
- [x] Run isolated UI/packing regressions and browser journeys with admin/viewer, then review and commit.

## Task 4 Complete backup and release tooling

Files: lib/runtime-backup.cjs, tools/backup-runtime.cjs, tools/release*.cjs or scripts, docker-compose.staging.yml, Dockerfile/.dockerignore where tools are needed, tests/runtime-backup.cjs, tests/release*.cjs, .github/workflows and operational docs.

Produces versioned backup+manifest, validated restore-to-empty, separate staging configuration and a release path that deploys the exact staged image with rollback.

- [x] Write failing full-file byte restoration, checksums, malformed manifest, traversal, nonempty restore and interrupted backup tests.
- [x] Implement full backup/restore and retention; parent calls scheduled backup from server and uses frozen-writer backup before production.
- [x] Add staging/release dry-run tests, implement scripts and CI test workflow without embedding credentials or overwriting unrelated GitHub repository content.
- [x] Verify remote repository/runner/access, separate staging directory, privately provision viewer, run restore drill and staged gates, then use the tested release path for production.

## Task 5 Integration and release verification

- [x] Run all safe local suites and isolated E2E, record every failure; fix integration issues and complete independent spec/quality review.
- [x] Commit versioned release; publish only to the authorized repository/branch after inspecting existing contents, attach a PR if created.
- [x] Build once, stage with separate data, verify viewer/admin/read-only Odoo and restore drill, back up production coherently, deploy and verify public routes/data counts/roles.
- [x] Record current runtime/release evidence, rollback commands and any cloud credential/runner limitation accurately in docs; do not label unrun automation active.

## Execution ledger

Local implementation and independent review complete. Baseline: d0c1df8 (private local history). Full isolated run: 127/127 primary tests, 20 groups without failures, packing and admin/viewer browser journeys passed. Final scoped integration review: 20/20 HTTP/workflow tests, four findings resolved. Remote image runtime passed, GitHub Actions38882428180 passed, staging passed and production promoted image97327c6 from sourcea33d83a with backup+restore verified. See docs/STABILIZATION-2026-10-16.md for actual evidence.

Ruling: Existing dirty source is the already deployed baseline; preserve it before feature changes and never reset or discard it. All changes remain on a codex branch in the authorized project workspace.

Ruling: PO quantities/receipts and permit applicability will not be inferred from document names. Checklist/owner/due fields are explicit admin data; Odoo remains read-only.
