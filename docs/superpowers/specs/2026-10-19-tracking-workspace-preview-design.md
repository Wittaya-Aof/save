# Reversible Logistics workspace preview

User approved the proposed Shipment table, daily work, schedule and retained Kanban, and explicitly requires returning to the old UI if dissatisfied. Implement a working opt-in UI on the existing React/HTML application, not a data migration.

- Existing URL defaults to classic. `?layout=operations` opens the preview; visible `ใช้หน้าตาเดิม` returns immediately to classic and persists the local browser preference. `ลองหน้าตาใหม่` reopens it. Preference/query changes never write business data. A blocked localStorage must not break navigation.
- Preview defaults to a searchable Shipment/PO table. Retain company/type/search, Excel, details/edit permissions and Kanban; expose daily work and chronological schedule views from the same filtered rows. Keep Dashboard and original worklist available.
- Display permanent Shipment IDs only when present. Unassigned source POs remain visibly PO records awaiting shipment planning. Show related PO references without joining by name or inventing quantities. Many-to-many quantity allocation and new backend statuses are future work, not fabricated by this UI.
- Show transport, recorded document work and next action separately. Unknown checklist is unassessed, not complete; pending TISI means check conditions, not automatically a missing mandatory permit. Tax payment notice is coordination, not proof of payment.
- ETA/ETD are estimates. Past ETA without actual evidence is `เลยกำหนด / รอยืนยัน`, not an asserted carrier delay. Never relabel ETA or generic task dueDate as a warehouse appointment. Distinguish actual port arrival and recorded warehouse receipt.
- Reuse existing cost functions; unknown FX/allocation remains incomplete. No totals or permissions logic duplicated in the new presentation helper.
- All existing operational records, revisions, company scope and write protections remain unchanged. Classic UI retains existing behavior. Import/export have separate transport label sets.
- New helper is served by an explicit static allowlist and included by existing Docker build allowlist. No new runtime dependencies.
- Stage and promote a single immutable image using existing CI/full backup/restore workflow. Keep the current release as rollback, and provide per-browser UI rollback without server downtime.

Builder decisions: opt-in preview protects other users; reuse existing design tokens; responsive table scrolls within its panel, daily cards work on mobile; schedule is a date-grouped timeline with an explicit date range. Sorting/pagination must never hide how many rows exist, and unknown dates stay separate.
