# Control Cloud stabilization — 16 October 2026

## Implemented and locally verified

- Strict persisted revisions and atomic rejection of invalid/stale tracking batches; failed writes return failure and preserve previous data. Legacy full replacement is disabled. Quote conflicts/deletions cannot silently overwrite or resurrect records.
- Exact shared administrator identity and separate shared viewer; server-side mutation checks, read-only UI and safe account lifecycle. Existing owner-selected administrator credential is preserved privately.
- Additive immutable shipment IDs, explicit PO references and import document checklist with responsible person and deadline. Legacy splits remain linked without inventing receipt quantities. Follow-up work appears when explicitly due.
- Company/currency/direction-scoped FX, scoped PO line requests, signed discounts/refunds and explicit missing-rate handling.
- Canonical save acknowledgments, refresh/conflict race protection, partial board outage visibility, bill selection persistence and payload/pallet weight enforcement. Ambiguous legacy names are flagged and blocked for unsafe name-based edits.
- Full runtime backups with SHA-256 manifest, byte-exact isolated restore, retention and separate staging data; immutable-image staged promotion with rollback. Environment credentials are stored separately from runtime backups.

## Verification before remote release

Full isolated test run: 127/127 primary tests, all 20 groups passed, including packing invariants/capacity/planning and mocked plus actual-handler browser journeys for viewer/admin. Independent reviews resolved frontend refresh issues, strict live-Odoo release gates and four persistence/permission/scope findings. No test mutated production business records.

## Release evidence

Remote container integration, GitHub Actions and production promotion are pending at this source snapshot. This section will be updated with actual results.

The GitHub repository is public. Runtime files, private environment files, credentials, backups and actual example PO identifiers are excluded from publication. Local baseline history containing private case references is not pushed; the reviewed sanitized source tree is published on a new codex branch atop the existing remote main without force-push.

## Operation

See [BACKUP-AND-RELEASE.md](BACKUP-AND-RELEASE.md) for backup coverage, restore constraints, promotion gates and rollback commands. GitHub Actions runs source tests; production promotion remains a separate gated command. SSH deployment credentials have not been provisioned in GitHub. Email remains disabled; Odoo remains read-only.
