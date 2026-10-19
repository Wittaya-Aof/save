# Three module correctness fixes

The user approved fixing all 24 findings in the review of e04f723. Preserve the existing Node/HTML application, shared read-only Viewer and admin/developer write permissions. No redesign or new external integrations. Production promotion follows existing CI, isolated staging, frozen full backup/restore drill and immutable-image checks.

## Tracking and shared cost rules

- L1: A real PO retains its original total as source metadata; displayed shipment allocations must not double-count synthetic lots. The remaining base shipment plus its splits must reconcile to that total. Never rewrite historical operational records automatically. Flag invalid/overallocated historical data instead of silently inventing an allocation.
- L2: Missing/invalid foreign FX is unknown, never 1:1 or a hardcoded guess. Incomplete financial values must remain visibly incomplete, including exports.
- L3/L4: Currency rates are scoped by company and effective date, with company-specific rates preferred over global rates. Future rates cannot replace a valid current rate. The rates endpoint returns company_id and one currency row per supported company; the Tracking page must retain that scope.
- L5: Every derived import status belongs to the current import column set.
- L6: Tracking overrides and shipment identities are matched by company, board and PO/order identity; one saved override cannot contaminate another company's same-named PO.
- L7: Late bill-picker responses cannot change the active company's picker; selected bills must match the active shipment.
- L8: A PO-level partial receipt plus estimated arrival is not proof that a particular lot was received. Only shipment-specific actual evidence or explicit manual receipt confirmation closes a split.
- L9: Explicit manual status changes use acknowledged state, with floors based on actual Odoo evidence rather than obsolete UI state.
- L10: New split identifiers remain unique after deleting any sibling.
- L11: A consolidated invoice referencing several expense POs suppresses those already-billed PO estimates within the same company. Match complete reference tokens, not substrings.

## Container rules

- C1: Placed cartons need a supporting footprint. Use a conservative, deterministic full-footprint support rule; reject unsupported upper layers. Capacity heuristics may not override physical validity.
- C2: Preserve actual piece count for partially filled final cartons in tables and CI/PL, including allocations across multiple results.
- C3: Apply SKU-specific height limits consistently to pallet packing and repacking.
- C4: A selected vehicle that cannot load an item cannot prevent trying later distinct selected specs; repeated-spec no-progress loops must still terminate.
- C5: Drum prediction and actual packing use the same permitted orientations.
- C6: Export/import CSV handles quoted commas, quotes, newlines and BOM while preserving legacy simple CSV inputs.
- C7: Reject nonfinite/negative weights and other physically invalid dimensions/counts before declaring a load valid. Zero weight can remain an explicit unknown/not-provided value only if it is not presented as confirmed payload safety.

## Freight rules

- F1: PDF amounts, including tiers, retain currency meaning. Normalize compatible currency for an option without altering another provider's entered amounts, or reject incompatible rows with a visible explanation.
- F2: Save/delete acknowledgements apply to the submitted quote identity and revision. Changes made while a request is pending remain dirty and recoverable; another open quote is unaffected.
- F3: Tier editor works on a draft; Close/Escape/backdrop discard it, Apply recalculates and marks dirty.
- F4: Excel unit prices use the effective tier used in the amount; totals and rate columns reconcile.
- F5: PDF import's fill-only-empty policy includes tiered and existing flat freight. Replacements require an explicit alternative action, not a hidden overwrite.
- F6: Missing FX/quantity basis makes a populated charge unresolved. No fair/cheapest recommendation is issued for incomplete financial input.

## Implementation decisions

Use small pure helpers where rules are shared or need direct testing; avoid broad rewrites of existing large pages. Existing quote/tracking data formats remain readable. Add derived metadata rather than migrating persisted amounts. Unknown values are represented as null with explicit UI/report status. Tests use isolated fixtures only, never live ports, real operational files or external Odoo/AI.
