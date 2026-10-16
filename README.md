# Import-Export Control Cloud

Source workspace for `https://control.import-export.cloud/`.

## Current locations

| Purpose | Location |
|---|---|
| Active local project | `C:\Users\User\Projects\import-export-control-cloud` |
| Local development URL | `http://127.0.0.1:3002/` |
| Local runtime data | `data/` (gitignored) |
| VPS source | `/srv/import-export-control-cloud` |
| VPS runtime data | `/srv/import-export-control-cloud-data` |
| Private VPS staging | `import-export-control-cloud-stage` |

This repository was separated from the local Import-Export OS source with independent Git object storage and no remote pointing at the old local folder. Its dependencies are installed independently. Local credentials were copied privately to its own `.env`; they are never part of Git or the image. Data was copied into this project's own `data/` directory; it is not a symlink to the retired source.

The original folder is retained as a reference/rollback copy, not deleted. Existing Windows startup jobs and the old local listener have not been disabled as part of this separation.

## Local development

```sh
npm ci --omit=dev --ignore-scripts
npm start
```

The private `.env` selects `HOST=127.0.0.1`, `PORT=3002`, and this project's own `DATA_DIR` and CA path. Public containers use port 3000 internally. Do not use local `.env` as the VPS deployment environment.

## Tests

`npm test` runs the isolated API, permissions, financial, backup/restore and UI-method
regressions plus the existing safe data-rule checks. `npm run test:full` also runs
packing suites and browser journeys, including the actual HTTP application with
temporary data and a random port. Install the Playwright Chromium runtime before
browser tests. These commands never send mutating tests to the public domain or
the occupied local ports. Legacy tests that assume localhost:3000 must only run
inside their own isolated test environment.

```sh
node tests/runtime-port.cjs
node tests/runtime-paths.cjs
node tests/manage-users-data-dir.cjs
node tests/manage-users-dotenv.cjs
node tests/mcp-live-fallback.cjs
node tests/verify-deployment.cjs
node tests/mail-disabled.cjs
node --test tests/odoo-api.cjs tests/odoo-boards.cjs tests/odoo-services.cjs
node tests/odoo-source-routing.cjs
node tests/users.cjs
node tests/shipment-stage.cjs
node tests/worklist.cjs
node tests/container-cleanup.cjs
```

`tests/deployment-runtime.cjs` is an isolated container integration test, not a test to run against a busy local server. See `docs/VPS-DEPLOYMENT.md`.

## Online status and cutover

The public domain now runs this application using the Odoo 18 HTTPS API. Cutover completed on 2026-10-16 after live data parity, isolated runtime tests and private staging verification passed. Public checks returned 369 import rows, 140 export rows and 1,087 tracking records. The incumbent and private staging containers are stopped; recoverable backups are retained on the VPS.

Email is intentionally disabled with `MAIL_DISABLED=1`; diagnostics report `explicitly-disabled`, not successful mail authentication. The old direct RDS and MCP paths are not used in API mode. A snapshot-backed 200 response is not a live-integration pass. The verifier remains `readyForCutover=false` in remote HTTP-only mode or if required evidence is missing. See `docs/STAGING-STATUS.json` for the deployment record.

See `docs/VPS-DEPLOYMENT.md` for backup, deployment, cutover and rollback. Never run the production Compose file just to smoke-test staging: it declares the production domain's router.

## Stabilization and roles

The shared `viewer` account reads the same business data as admin but cannot
mutate server state. Only authenticated admin/developer roles can edit. The
existing shared admin credential remains privately configured on the VPS; the
viewer password is separate. `tools/copy-deployment-password.ps1 -Role viewer`
copies it privately through the owner's existing SSH connection.

Tracking writes require the exact loaded `_baseTs`; the server creates `_ts`.
Freight quotes compare their loaded `updatedAt`, including deletion. Legacy
replace-all tracking writes are disabled. Stable `_shipmentId` and `poRefs`
provide additive shipment-to-PO identity; owner, due date and an explicit import
document checklist support daily follow-up without inventing received quantities
or permit decisions. Read-only GET `/api/shipments?po=...` and `/api/worklist` expose
these links and work items.

Full runtime backups, validated restore-to-empty and the immutable-image
staging/promotion/rollback command are documented in
`docs/BACKUP-AND-RELEASE.md`. Staging has its own data directory and private env.
GitHub Actions runs source-only isolated tests on codex branches/main/PRs;
production promotion uses the gated release command, not an ungated source push.

The optional `ODOO_DATA_SOURCE=api` mode reads Odoo 18 over HTTPS using `ODOO_API_URL`, `ODOO_DB`, `ODOO_LOGIN`, and `ODOO_API_KEY`. Configure these privately in the server environment. `.env.odoo-api` is an ignored local credential-entry file and is not loaded automatically by the server or copied into the image. API mode covers boards, order lines, vendors, scorecards, GL reconciliation, logistics bills and exchange rates without direct PostgreSQL or MCP queries. Readiness still requires fresh data, authentication and successful supporting routes.
