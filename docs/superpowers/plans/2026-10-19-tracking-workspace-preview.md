# Reversible Tracking Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline for the coupled UI change, then one independent whole-branch review. User already approved the proposed UI and requested immediate reversible implementation.

**Goal:** Show an opt-in operational Shipment table, daily actions and schedule with instant classic rollback and no business-data migration.
**Architecture:** A pure UMD presentation helper summarizes existing mapped records; the existing React page renders views and persists only layout preference. Existing write paths remain intact.
**Tech Stack:** Existing Node, React HTML, design tokens, node:test and Playwright.
**Spec:** docs/superpowers/specs/2026-10-19-tracking-workspace-preview-design.md

## Global Constraints

- No business data migration, invented Shipment IDs, quantities, payment confirmations or receipt dates.
- Classic remains default unless preview chosen; a visible browser-local rollback works even when storage is blocked.
- Existing permissions, costs, revisions and company scope remain authoritative.
- No new runtime dependencies or external integrations; fixture-only tests before staging.

## Review Focus

- Unknown checklists and FX must stay unknown; TISI and payment-notice wording must not assert compliance/payment.
- Closed transport with pending paperwork can still have daily actions.
- Same PO across companies remains distinct; new views use existing row IDs/detail handlers.
- Local storage denial/query persistence must not strand users in preview.
- Empty, historical, mobile and many-row views must show counts/date limits without implying omitted rows do not exist.

### Task1: Presentation rules and reversible preference
Files: new lib/logistics-workspace.js and tests/logistics-workspace.cjs; api-server.js explicit static route.
Interfaces: describe(row,today,{cost,expense}) returns a derived summary; select(rows,focus), schedule(rows,from,to), today Bangkok YYYY-MM-DD; layout choice helpers. No mutation and no cost recalculation.
- [ ] Write failing fixtures for unknown/closed/pending/TISI/notice dates, duplicate names/scopes, frozen input and layout fallback.
- [ ] Run RED; implement minimal helper/static route; run GREEN plus existing routing/finance checks; commit.

### Task2: React preview and actual browser journeys
Files: import-export-os.html, new tests/logistics-workspace-browser.cjs; tools/run-tests.cjs.
- [ ] Add failing browser checks for opt-in table, filters/counts, daily actions, schedule dates, details, viewer/admin permissions, layout rollback/reload, blocked storage and narrow screen.
- [ ] Add preview header/summary/view controls and table/actions/schedule using Task1 summaries; preserve classic renderers and existing write handlers. Add empty states and explicit incomplete values.
- [ ] Register tests, run focused tests then full suite, capture screenshots and commit.

### Task3: Review and delivery
- [ ] Independent read-only whole-branch review, fix important findings with RED/GREEN evidence.
- [ ] Push codex branch, require successful Linux CI, build/test immutable image and isolated staging.
- [ ] Full backup/restore drill, promote identical image, verify live classic+preview roles/read-only UI switches and fresh Odoo. Fast-forward local service only after passing.
- [ ] Open preview for user and document one-click classic URL/button plus immutable previous-release rollback; preserve private evidence and clean managed worktree.
