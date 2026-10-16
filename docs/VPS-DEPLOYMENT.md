# Import-Export OS: VPS deployment and cutover gate

## Verified topology

- App source: `/srv/import-export-control-cloud`
- Private staging container: `import-export-control-cloud-stage`, no published ports, `traefik.enable=false`
- Data: `/srv/import-export-control-cloud-data` mounted as `/data`
- Runtime user: UID/GID `1000:1000`; directories `0700`, files `0600`
- Live environment file: `/srv/import-export-control-cloud/.env.hostinger`, mode `0600`; never commit or print it
- Existing Traefik uses host networking and discovers Docker bridge IPs. An external shared Docker network is not required on this particular host.
- Public domain stays on the incumbent control-center until all gates pass.

Execution update, 2026-10-16: the gates passed using the Odoo 18 HTTPS API and the public domain now uses `import-export-control-cloud-app-1`. Both the incumbent `import-export-control-center-app-1` and private staging `import-export-control-cloud-stage` are stopped. The `/data` directory mount and private server environment file remain as described above. Production diagnostics and authenticated public checks passed, including fresh import/export data and supporting routes.

## Source and data boundaries

The Docker context is allowlisted; Dockerfile COPY statements list sources explicitly. No tracking, audit, snapshot, backups, users database, `.env`, logs, or historical runtime variants belong in an image. `rds-ca.pem` is a public CA certificate, not a private key. Never add private keys or live environment files to the allowlist.

`DATA_DIR=/data` controls both the API and `manage-users.mjs`. File-backed operational data stays on a directory mount so same-directory temporary-file renames remain atomic. Do not bind-mount each JSON file separately: rename onto a file mount fails with EBUSY.

Before the first deployment, provision the data directory deliberately:

```sh
install -d -o 1000 -g 1000 -m 0700 /srv/import-export-control-cloud-data
```

Copy operational data separately from source, while the target writer is stopped. Set ownership to `1000:1000`, directory permissions to `0700`, and file permissions to `0600`. Never seed or overwrite an already-populated directory on routine redeploy. The container entrypoint applies `umask 077` to new runtime files.

## Build and tests on the VPS

```sh
cd /srv/import-export-control-cloud
docker compose -f docker-compose.hostinger.yml config --quiet
docker compose -f docker-compose.hostinger.yml build
# Tests are deliberately not included in the application image.
docker run --rm --network none -e TEST_APP_ROOT=/app \
  -v /srv/import-export-control-cloud/tests/deployment-runtime.cjs:/tmp/deployment-runtime.cjs:ro \
  import-export-control-cloud-app node /tmp/deployment-runtime.cjs
```

The isolated test uses temporary fixture data, not live data or integrations. It covers startup byte-preservation, authentication, CLI changes observed by the API, atomic tracking writes, private file permissions, and restart persistence. Run it in an isolated container; do not point it at the local user's occupied port 3000.

Local focused checks:

```sh
node tests/runtime-paths.cjs
node tests/manage-users-data-dir.cjs
node --check api-server.js
node --check manage-users.mjs
```

## Private staging and diagnostics

### Optional Odoo API mode

Set `ODOO_DATA_SOURCE=api` and configure `ODOO_API_URL`, `ODOO_DB`, `ODOO_LOGIN`, and `ODOO_API_KEY` privately in `.env.hostinger`. The client only permits read methods over verified HTTPS and fixes company context to IDs 1 and 2. Existing SQL/MCP mode remains the default when this setting is absent. API mode does not need direct RDS or the old MCP credential.

Before cutover, compare API results with the existing direct data, including amounts, rates, categories, receipt dates and supporting routes. Resolve unexplained omissions or mismatches; successful API authentication alone is insufficient. The verifier accepts `via=api` only with fresh forced board reads, successful server-side API authentication and healthy supporting routes. `via=snapshot` and HTTP-only diagnostics remain insufficient. Credentials belong only in private environment files, never in reports or an image.

### Container checks

The staged container runs the same image as the eventual service, with:

- `HOST=0.0.0.0`, `DATA_DIR=/data`, `DB_SSL_CA=/app/rds-ca.pem`
- Live `.env.hostinger` supplied via Docker `--env-file`
- `/srv/import-export-control-cloud-data:/data`
- `traefik.enable=false`, no published port
- `ALERT_EMAIL_TO=` override to prevent staging from sending real alerts

The diagnostic script can be mounted read-only at `/tmp/verify-deployment.cjs`. Run:

```sh
docker exec import-export-control-cloud-stage node /tmp/verify-deployment.cjs
```

It prints counts and statuses only, not credentials or shipment contents. Verify `/api/alive`, unauthorized and invalid credentials `401`, valid tracking access, HTML/cache headers, calculator and freight routes, fresh import/export queries, direct database connectivity, and mail authentication. A successful script exit only means the diagnostic ran; `readyForCutover` must be `true` before cutover. `VERIFY_BASE_URL` mode is HTTP-only and always leaves readiness false because it cannot check server-side DB/mail credentials. Both forced board queries must explicitly report `via=direct` or `via=mcp` and `stale=false`; recent snapshots never count as live evidence even when `stale=false`. The local check must verify mail and either a working direct DB path or live MCP results for both boards. Diagnose MCP initialization failures from the staged logs without copying full sensitive logs into chat.

When the owner explicitly defers email, set `MAIL_DISABLED=1` in `.env.hostinger`. This suppresses both SMTP and Graph verification and sending; diagnostics report mail as `mode=disabled`, `code=explicitly-disabled`. It does not waive fresh-data checks, account access, or HTTP-only verification limits. To enable email later, remove this flag, configure the chosen mail provider, recreate the container, and verify authentication before enabling recipients.

The existing shared username can be retained while rotating its password privately in `.env.hostinger`. The local helper `tools/copy-deployment-password.ps1` copies that password through trusted SSH to the owner's clipboard without displaying it. It requires the owner's existing SSH access and does not store the password locally.

## Historical direct/MCP failures

As observed on 2026-10-16:

- Direct database connectivity fails from VPS.
- MCP initialization returns HTTP 401.
- Import/export endpoints return saved snapshots with `stale=true`, not fresh data.
- SMTP verification originally returned authentication error 535. The owner subsequently deferred email, so staging uses `MAIL_DISABLED=1` instead.

These legacy connection failures no longer block the active deployment: production uses `ODOO_DATA_SOURCE=api`, authenticated successfully to the owner-provided Odoo URL, and reads both companies. If email is enabled later, repair mail authentication using an approved SMTP or Microsoft Graph configuration supported by `lib/mailer.cjs`. Edit secrets through the authorized server-side secret workflow; do not paste them in chat, arguments, reports, or source control. Recreate the container after changing its env file: restart alone does not reload Docker environment values.

Before public use, replace weak shared credentials with a strong credential or the existing per-user account system. Do not change an existing user's requested credential silently.

## Cutover and rollback procedure

1. Re-run the diagnostics and independent code review; require all gates to pass.
2. Confirm acceptable data freshness and account access with the owner.
3. Freeze writers, create a fresh recoverable incumbent backup, and preserve its checksum and environment file privately. An earlier verified backup is `/root/import-export-migration-backups/control-center-20261016T024243Z.tar.gz`.
4. Stop private staging before starting the Compose app: only one active writer may own the runtime data directory.
5. Stop the incumbent app, then start the new Compose app, ensuring only one router owns the production Host rule.
6. Verify HTTPS, authentication, tracking counts, core pages, fresh integrations, and persistence on the public URL. Keep the incumbent source/data and its backup intact.
7. If validation fails: stop the new Compose app, restart the incumbent with its original Compose configuration, and verify its public `/api/health` and authenticated application routes. Do not restore or overwrite original data unless required and explicitly authorized.

Do not run `docker compose up` on the production Compose file merely to test staging: its labels claim the production domain.

## Completed cutover record

Cutover completed on 2026-10-16 at approximately 14:28 Asia/Bangkok. The frozen-writer backup is `/root/import-export-migration-backups/cutover-20261016T072807Z/`, containing verified incumbent and cloud archives with SHA-256 sidecars, production diagnostics and the result record. The previous image is retained as `import-export-control-cloud-app:before-api-20261016t072501z`.

The public domain returned authenticated HTML and tracking successfully, rejected unauthenticated tracking with 401, and returned fresh `via=api`, `stale=false` boards (369 import, 140 export). All supporting data routes passed. The tracking count remained 1,087 and tracking/freight file hashes were preserved across cutover. Exactly one running Traefik router owns the domain. Email remains intentionally disabled. Do not start the stopped staging container while production owns the shared data directory.
