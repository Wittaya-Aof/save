# Control Cloud stabilization and import workflow

## Approved scope

The owner explicitly requested implementation of the review recommendations on 2026-10-16: fix persistence/concurrency, then FX/cost correctness, then UI/loading; full backups with restore drill; separate staging data; versioned test/staging/production deployment; persistent shipment identity linked to PO, containers, B/L and bills; daily work with owner and due date.

The priority is tracking status and costs. Purchasing, warehouse, sales, accounting and management can view. Only administrators and web-app developers may mutate business data. A separate shared viewer account is requested; preserve the owner's existing admin credential rather than silently rotating it. The designated Git repository is git@github.com:Wittaya-Aof/save.git. Inspect its existing branches/content before adding project files; do not overwrite unrelated work or force-push.

## Existing application and boundaries

Use the existing plain Node HTTP/CJS and standalone HTML application. Odoo API is read-only over HTTPS, company IDs 1 and 2. Email remains explicitly disabled. Production data is /srv/import-export-control-cloud-data. No live business-record mutation for tests, no source secrets/runtime files in Git/images, and no automatic erasure/reseeding of populated data.

## Persistence and authorization

Disable legacy replace-all tracking POST. Fail closed on malformed/unreadable operational JSON; return HTTP failure on failed persistence. Use server-created monotonically increasing revisions with exact equality for interactive edits. Clients capture the loaded revision before optimistic updates. Support existing controlled scanner fill-empty writes without making interactive requests silently bypass revision guards. Freight quotes use the same stale-update discipline.

Authenticate the exact configured shared admin username, a separate shared viewer username/password, and optional individual users with explicit roles admin/developer/viewer. Default unknown/missing roles to viewer. All business mutations require admin/developer on the server; the UI hides write controls for viewers. Removing the last usable administrative account must not expose an unauthenticated service. Keep local no-auth mode only on loopback when explicitly applicable. Expose GET /api/me for effective identity/permissions. Backups include the account store without printing credentials.

## Financial corrections

FX repair must match source company, currency and transaction direction; never borrow another company's refund by document name. PO/SO line requests include company or Odoo record ID and cache by that scope. Preserve signed discounts/refunds so category sums reconcile. Missing foreign-currency rates produce an explicit unknown THB result, not an implicit 1:1 conversion. Do not change future-rate business policy without evidence; mark date/source clearly.

## UI and loading corrections

Handle actual JSON write results, reload conflicts through loadData, retain successful old data for an unavailable board, and display incomplete freshness. Preserve bill-picker targets during retry and persist bill IDs/categories through edit/reload/duplicate detection. Loading must respect payload and pallet/item weight limits, include pallet weight, and distinguish geometric fit from an operationally valid recommendation. Preserve geometry invariants and existing capacity for weight-unconstrained cases.

## Shipment and daily import work

One PO can be split into an unpredictable number of shipments due to supplier production/readiness problems. Track both PO and shipment with a persistent shipment ID, explicit parent PO reference(s), and existing container/B/L/bill links. Retain legacy po_so and split references for compatibility; migration is additive and idempotent. Never invent shipment quantities, dates, receipt confirmation or bill allocations from PO totals. Existing split shipments must not double-count the parent PO amount.

The owner's four PO examples were inspected read-only; actual business identifiers remain in the private execution notes. Supply-chain import/export contact is Wittaya Sawangphol. Workflow covers supplier Commercial Invoice, Packing List, Form E; forwarder coordination; B/L, insurance, Form E and import-declaration checks; TISI permit follow-up when applicable; warehouse arrival notice; and import-tax payment notice to accounting. Implement editable owner/due date and an explicit checklist; TISI applicability is an admin-confirmed value, not automatic legal classification. These are operational follow-up tasks, not automated regulatory determinations or external messages.

## Backup and release operations

Create coherent versioned full runtime backups covering tracking, freight quotes, users, audit and auxiliary ledgers, with SHA-256 manifest, restrictive permissions and retention. Restore first validates every entry and writes only to a new/empty isolated directory. Test full-byte restoration and tamper/path traversal rejection. No restore to production as a test.

Staging uses /srv/import-export-control-cloud-staging-data and no production router. Make its environment/data separate; disable real email/AI delivery and scheduled mutations as needed. Deploy a versioned immutable image to staging, run isolated fixture and read-only integration checks, take a frozen-writer production backup, then deploy the same image with rollback available. Persist live data and account settings.

Add repeatable local/CI tests and deployment scripts. GitHub repository access, default-branch contents, available runner and deployment credentials must be verified rather than assumed. Do not claim a cloud workflow active until it has actually run. If CI credentials cannot be provisioned from existing authorized access, deliver the tested manual release path and exact missing setup; do not fabricate an active pipeline.

## Validation

Regression cases from PROJECT-REVIEW-2026-10-16.md; isolated HTTP tests for admin/viewer/forged usernames/stale edits/storage failures; adapter tests; HTML method and browser tests on isolated fixture server; geometry/capacity/payload tests; backup/restore byte comparison; deployment dry-run and independent review; staged then public HTTPS checks. Never point mutating tests at the user's existing ports 3000/3002 or public business data.
