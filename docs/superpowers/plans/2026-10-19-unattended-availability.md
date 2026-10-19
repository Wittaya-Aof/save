# Unattended availability implementation plan

> Execute inline using superpowers:executing-plans. User authorized diagnosis, repair and unattended recovery.

**Goal:** Restore localhost after Windows restart and recover the actual production service without Codex, while distinguishing web availability from expired Odoo access.

**Architecture:** A task-owned local child supervisor, a host timer with bounded recovery, and authenticated readiness reporting. Liveness never depends on Odoo. Recovery never writes business records or restarts for upstream authentication failure.

**Stack:** Existing Node HTTP, Windows Task Scheduler, Linux systemd, Docker Compose.

## Evidence

- Local computer restarted on 19 October; port3002 has no listener and no startup task targets this project. The old project's launcher serves a separate app.
- Public DNS/HTTPS/login and production container are running. The stopped control-center in the supplied screenshot is retired, not the current app.
- Production served saved Odoo snapshots; the previous API key UI showed expiry17October. Replacement key initially authenticated and staged boards read fresh, then fresh authentication was rejected on both local and VPS. Replacement expiry confirmation remains outstanding.
- Docker restarts exited processes but existing setup has no recovery for an alive-but-hung process. VPS reboot history shows a provider/host outage; one host cannot provide continuous service during its own outage.

## Constraints

- Preserve user-selected credentials and all data. No new secrets/runtime/host operational records in public Git.
- Never restart retired app containers or kill a process just because it occupies a port.
- Release and watchdog must share an exclusive operation lock; paused release recovery has a bounded lease.
- Windows registration should use current-user logon when administrative service installation is unavailable; report that boundary accurately.

## Tasks

- [x] Add failing tests and implement readiness/freshness/key-expiry reporting and truthful warm-up logs.
- [x] Add local child supervisor with singleton ownership, bounded retry and health recovery; install a persistent logon/repeating Task Scheduler task and verify child restart.
- [x] Add root-owned VPS guardian timer with three failed probes/cooldown, release coordination, app/proxy-specific recovery, and no restart on Odoo/DNS-only failures. Test failure decisions and release exclusion.
- [x] Configure local private Odoo/account settings. Validate replacement key and expiry; deploy only after strict Odoo checks, or explicitly preserve a degraded status if upstream input remains invalid.
- [x] Run regression/CI, safe staging recovery drill, production read-only checks, and record verified startup/recovery evidence privately with a redacted user report.

## Verification checkpoint

All 22 isolated test groups pass. Real image persistence/entrypoint checks pass. Windows child and scheduled-supervisor recovery pass. Linux cross-process locking and staging recovery pass. A Linux process-close ordering race found during cross-platform testing was corrected and both platform tests pass. Public role login/logout and read-only tracking checks pass.

A subsequently saved replacement credential passes fresh Odoo authentication. Local and staging boards now return current API data, and readiness passes. The tested immutable image was promoted after a full frozen backup and isolated restore drill. External production API, browser sync and both role login/logout checks pass. Failed sync no longer advances the successful-sync timestamp or treats snapshot fallback as live data.

The Odoo account still limits credentials to one day. Expiry metadata and the visible warning are configured, but long-term credential duration requires the Odoo administrator. Service recovery does not extend or rotate Odoo credentials. Exact host paths, counts and execution records are retained only in ignored private notes.
