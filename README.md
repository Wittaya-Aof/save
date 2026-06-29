# Logistics Tracking Web App

Internal logistics tracking dashboard for **KOB (Kiss of Beauty)** and **BTV (Beautiville)** — Import & Export shipment kanban, dashboard, and Odoo sync.

## Stack

- **Frontend:** Single-page HTML (Bootstrap 5 + Chart.js + vanilla JS)
- **Backend:** Node.js + Express (`api-server.js`)
- **Database:** AWS RDS PostgreSQL (Odoo `kiss-production`, read-only)
- **Process manager:** `watchdog.js` — crash-restart, no pm2

## Files

| File | Purpose |
|------|---------|
| `api-server.js` | Express server (port 3000) — serves UI, proxies Odoo DB queries |
| `logistics_webapp_prototype.html` | Full single-page app (Import board, Export board, Dashboard) |
| `watchdog.js` | Node.js process manager — spawns api-server, restarts on crash |
| `DEVLOG.md` | Development log — all changes and decisions |

## Running

```
node watchdog.js
```

Server starts at `http://localhost:3000`. Watchdog auto-restarts on crash (5 s delay).

## Production startup

Windows Task Scheduler triggers `watchdog.js` on logon via a PowerShell launcher script.
