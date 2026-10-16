# Runtime backup and staged release

This is the tested local tooling and the operational setup it needs. A workflow file or a dry run is not evidence of a deployed release. The parent release owner records the actual host/repository checks, image ID, successful staging gates, frozen backup ID and production result separately.

## Backup contract

`lib/runtime-backup.cjs` exports synchronous `createRuntimeBackup({dataDir, backupDir, retain:14})`, `verifyRuntimeBackup({backupPath})`, and `restoreRuntimeBackup({backupPath,targetDir,liveDataDir})`. Creation returns `{backupPath,manifest,warnings}`. `now` and `fsImpl` can be supplied for isolated tests. The server should call creation synchronously from its daily backup callback. JavaScript writes cannot interleave in that event-loop turn; other processes must be stopped separately. A frozen-writer release backup stops the app before running the same image's backup CLI.

The fixed flat allowlist contains tracking_data.json, freight_quotes.json, users.json, tracking_audit.jsonl, shipment_runs.jsonl, ai_usage.jsonl, doc_scan_seen.json, integrity_seen.json, integrity_digest.json, odoo_snapshot.json and the optional rotated tracking_audit.jsonl.1, shipment_runs.jsonl.1, ai_usage.jsonl.1. Missing files appear explicitly in the manifest and are not synthesized during restore. New runtime files require an explicit allowlist and schema update. Environment files and nested old backups are excluded.

Each versioned backup has a manifest with the complete present/missing file partition, byte counts and SHA-256 checksums. JSON/JSONL structures are validated before publication and again during restore. Source bytes, including Unicode, whitespace and complete audit histories, are preserved. Unknown entries, duplicate filenames, traversal, symlinks, invalid schemas and changed checksums fail closed. SHA-256 provides corruption detection; someone who can rewrite both data and manifest can generate new hashes. Keep the backup root restricted and copy verified backups to a separately protected destination for disaster recovery.

Output directories use mode 0700 and files 0600 on POSIX hosts. Provision production and backup host directories for UID/GID 1000:1000. Windows development tests verify behavior; Unix permissions are also checked by the Linux CI job. Writes are flushed before the temporary directory is renamed to its completed version. Incomplete `.partial-*` directories are never restore candidates or retention candidates. Investigate abandoned partial directories before manually removing them.

The default retention keeps the latest 14 valid completed backups after a new backup has finalized. Invalid directories and unrelated contents are never pruned automatically. `history.jsonl` records completed backup IDs, dates and counts without accounts or business payloads. History/retention failure after successful publication returns `warnings`; scheduled callers must log and monitor them. Release promotion stops if its frozen backup returns warnings.

Backup storage must not overlap the live runtime directory. Production mounts `/srv/import-export-control-cloud-data:/data` and `/srv/import-export-control-cloud-backups:/backups`, with `FULL_BACKUP_DIR=/backups`. Legacy tracking-only backups remain untouched outside this backup scheme.

```sh
# Offline CLI: DATA_DIR has no active writers.
node tools/backup-runtime.cjs create /isolated/runtime /isolated/backups
node tools/backup-runtime.cjs verify /isolated/backups/runtime-VERSION
node tools/backup-runtime.cjs restore /isolated/backups/runtime-VERSION /isolated/restore-new
```

Restore validates and reads every byte before creating output. The destination must be absent or empty with an existing parent; it must be isolated from the backup and must have no symbolic-link ancestors. `/data`, `/srv/import-export-control-cloud-data` and an optional `liveDataDir` are prohibited. Restore to an isolated directory, compare expected files/counts and inspect privately. A restore drill never replaces production. Restored `users.json` contains existing password hashes; protect the drill directory accordingly. Shared account passwords from private environment files need separate protected storage and are not part of this runtime backup.

## Staging and manual release

`docker-compose.staging.yml` has its own project name `import-export-control-cloud-staging`, fixed `/srv/import-export-control-cloud-staging-data` bind mount, `traefik.enable=false`, and no published ports. Its private env file must differ from production. Seed only separate fixture data and preserve an intentionally configured admin/viewer pair. Use read-only Odoo credentials for companies 1 and 2. `DISABLE_SCHEDULED_MUTATIONS=1` disables scheduled writes; AI and delivery credentials are blanked by the compose configuration. The staging data directory is never a production mount.

Before first use, the release owner must:

1. Verify the intended Git repository/branch and preserve unrelated repository content. Authorized repository: `git@github.com:Wittaya-Aof/save.git`. Do not force-push.
2. Run all isolated regression suites and build once from the reviewed source. The Dockerfile must copy `tools/` so backup and verification commands exist in the image. Source/image inputs exclude environment files, runtime files and backups.
3. Prepare the production, staging and backup directories privately, and a release-state directory outside source and data. Verify there is only one app writer; stop any external scanner/writer before invoking release. Provision separate private staging environment credentials, and preserve production credentials/accounts.
4. Resolve the built image to its local `sha256:...` image ID, or use a pulled registry `name@sha256:...` digest. The script rejects mutable tags, does not rebuild, and never pulls during staging/promotion/rollback. Keep the previous local image available.
5. Use the actual existing production Compose project name, not an invented one. Verify Docker Compose supports `up --wait`, and that the release host has Node 22 and Docker access. Backups and staging data must be writable by UID 1000. A root release operator can prepare the isolated restore drill's ownership; a non-root operator must run as UID 1000.

Keep the private configuration outside Git and source. It contains paths and an image reference, not passwords:

```json
{
  "image": "sha256:REPLACE_WITH_64_HEX_IMAGE_ID",
  "sourceDir": "/srv/import-export-control-cloud",
  "productionProject": "REPLACE_WITH_EXISTING_PROJECT",
  "stagingEnvFile": "/srv/private/control-staging.env",
  "stateDir": "/srv/import-export-control-cloud-releases"
}
```

```sh
node tools/release-runtime.cjs plan /srv/private/control-release.json
node tools/release-runtime.cjs deploy /srv/private/control-release.json
```

`plan` validates configuration and prints the phases without Docker commands or filesystem writes. `deploy` acquires an exclusive directory lock, inspects the current container's immutable image ID, starts staging with the candidate image, verifies admin/viewer access and viewer write denial, and checks current import/export Odoo responses. Only then does it stop the production writer, create a full backup through the candidate image with production mounted read-only, and restore that backup into a fresh isolated drill directory. It promotes the exact staged image with the existing production data mount and runs GET-only production identity/data/Odoo checks.

Failures before production is stopped do not touch production. Failures after writer freeze attempt to start the previous immutable image, waiting for health. The deployment script never restores or deletes production data on rollback. Inspect any `rollback-failed` result immediately; do not claim recovery without a healthy service. The directory lock prevents concurrent script runs; a crashed process leaves a lock for operator inspection rather than silently allowing overlapping releases.

Each release directory records candidate and rollback Compose overrides. The state root has a concise JSONL release history. Promotion can succeed even if writing history fails; that result explicitly returns a warning. The isolated restore drill is retained privately for review; remove its contents only after verification under the organization's retention policy.

Manual image rollback after inspecting a release's record:

```sh
docker compose --project-name EXISTING_PROJECT \
  -f /srv/import-export-control-cloud/docker-compose.hostinger.yml \
  -f /srv/import-export-control-cloud-releases/RELEASE_ID/rollback-override.json \
  up -d --no-build --pull never --wait --wait-timeout 120
```

This rolls back the application image with runtime data retained. Record the outcome and perform GET-only public HTTPS checks. Data recovery is a separate, explicitly reviewed operation following an isolated restore drill.

## CI setup and evidence

`.github/workflows/control-cloud-tests.yml` runs isolated tests on pushes to `main` and `codex/**`, pull requests to `main`, and manual dispatch. It has read-only repository permissions and no SSH/deployment secrets. It does not automatically deploy production. Until it actually runs successfully in the intended repository, describe it as a prepared workflow. Production promotion uses the staged release command above. GitHub-hosted deployment additionally needs a protected environment and privately provisioned deployment access; no such access is assumed here.

Local regression commands:

```sh
node --test tests/runtime-backup.cjs tests/release-runtime.cjs tests/release-checks.cjs
```

The backup tests use temporary fixture directories. Release tests use a Docker boundary fixture and assert ordering, immutable image selection, lock contention, staging failure, frozen-backup failure and rollback. HTTP verification tests use an isolated ephemeral localhost fixture server. They demonstrate orchestration behavior without claiming an actual Docker, GitHub Actions, staging or production deployment has run.
