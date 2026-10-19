# Three module correctness implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. The user approved the reviewed 24 fixes and requested immediate execution.

**Goal:** Correct all 24 verified Tracking, Container and Freight defects without losing operational data.

**Architecture:** Keep the existing Node/HTML application. Implement independent module changes with regression tests; shared financial API fixes supply company-scoped effective rates and bill-reference matching. Integrate only through documented interfaces.

**Tech Stack:** Node.js CJS, existing React/vanilla HTML, Playwright, Docker Compose release tooling.

**Spec:** docs/superpowers/specs/2026-10-19-three-module-fixes-design.md

## Global constraints

- Preserve all stored operational data and current auth/Viewer restrictions.
- No secrets, operational records, actual business identifiers or host inventory in public Git.
- Reproduce each defect with a failing isolated test before its fix; no live app/API tests until staging.
- Workers own disjoint files; do not revert changes made by others.
- One immutable image is tested in staging and promoted with full backup/isolated restore and rollback available.

## Review focus

- Partial shipments across currencies, unknown FX and historical overallocations remain honest and bounded.
- Rapid quote/picker switches and edits while a response is pending cannot overwrite newer state.
- Mixed pallet/carton geometry and partial final cartons remain consistent across chained containers and exports.
- Company/global FX ties and future-only histories do not cross company/date boundaries.
- Existing stored data and read-only users retain correct behavior after the fixes.

## Task 1 Shared financial API L3 L4 L11

Owner root: lib/odoo-services.cjs, lib/logistics-costs.cjs, api-server.js, tests/odoo-services.cjs, tests/logistics-costs.cjs, tests/odoo-financial-sql.cjs.

Produces /api/fx-rates rows with currency, company_id, as_of, thb_per_unit, scoped by companies1/2 and date; no latest-across-company collapse. Existing rate (inverse) mapping remains explicit. Tokenize consolidated invoice PO references for suppression without substring matches.

- [ ] Add failing fixtures for company rates/global preference/future-only rates and consolidated references.
- [ ] Implement selection and direct-SQL parity; test missing-rate behavior and exact token/company matching.
- [ ] Verify existing supporting-data and finance tests; commit owned files only.

## Task 2 Tracking L1 L2 L5 L6 L7 L8 L9 L10

Owner tracking worker: import-export-os.html and new lib tracking helper if needed; tests/frontend-regressions.cjs, tests/browser-real-api.cjs, new tests/tracking-correctness.cjs.

Consumes Task1 rates including company_id; worker owns ALL Tracking-page edits, including company FX indexing and null-rate UI/export handling. Root will not edit this page concurrently.

- [ ] Add failing fixtures for eight reviewed behaviors and incomplete FX/allocation histories.
- [ ] Implement scoped overrides, reconciled shipment allocation, safe stage/receipt semantics, unique split keys and picker request guards.
- [ ] Verify existing Tracking permissions, persistence, source routing and browser flows; commit owned files only.

## Task 3 Container C1 C2 C3 C4 C5 C6 C7

Owner container worker: container-loading-calculator.html and container-specific helpers/tests only.

- [ ] Add regression fixtures for support, partial cartons, per-SKU height, selected-spec continuation, drum orientation, CSV roundtrip and invalid payloads.
- [ ] Implement conservative support validation and consistent piece/orientation/height accounting; preserve supported capacities where physically valid.
- [ ] Run all geometry/capacity/lane/plan regressions plus seeded fuzz and isolated UI tests; commit owned files only.

## Task 4 Freight F1 F2 F3 F4 F5 F6

Owner freight worker: freight-comparison.html and freight-specific new pure/isolated tests only.

- [ ] Add failing actual-function tests for PDF currency/empty-only behavior, pending save/delete state, modal cancellation, effective exported rate and incomplete comparison.
- [ ] Implement snapshot/identity-aware response handling and draft tier editing, retain currency semantics and comparison completeness.
- [ ] Run new tests and existing fixture-only Freight/browser tests; legacy fixed-port/mutating suites must not use running apps; commit owned files only.

## Task 5 Integration review and release

Owner root: tools/run-tests.cjs, shared browser tests only after workers finish, docs verification records.

- [ ] Register all new fixture-safe tests; run complete 22-group baseline plus new suites on the isolated worktree.
- [ ] Dispatch independent spec/quality reviews; fix important findings and repeat scoped tests.
- [ ] Commit/push versioned source, require CI success, build immutable image and validate staging fresh Odoo/read-only roles.
- [ ] Freeze writer, create full backup, verify isolated restore, promote tested image and perform production GET/browser checks.
- [ ] Update local checkout only when fixes pass; retain stable startup/supervisor and record exact private recovery evidence outside Git.
