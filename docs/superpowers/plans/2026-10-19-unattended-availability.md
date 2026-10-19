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

- [ ] Add failing tests and implement readiness/freshness/key-expiry reporting and truthful warm-up logs.
- [ ] Add local child supervisor with singleton ownership, bounded retry and health recovery; install a persistent logon/repeating Task Scheduler task and verify child restart.
- [ ] Add root-owned VPS guardian timer with three failed probes/cooldown, release coordination, app/proxy-specific recovery, and no restart on Odoo/DNS-only failures. Test failure decisions and release exclusion.
- [ ] Configure local private Odoo/account settings. Validate replacement key and expiry; deploy only after strict Odoo checks, or explicitly preserve a degraded status if upstream input remains invalid.
- [ ] Run regression/CI, safe staging recovery drill, production read-only checks, and record verified startup/recovery evidence privately with a redacted user report.
