# REG SLAYER — TestOffline **V1.03 Beta**

Field / experimental mirror for the **context + canvas** restructure. Production (regslayer.com / Hunt-Slayer) is **not** affected by this repo.

| | |
|---|---|
| **Version** | `1.03-beta` · badge **V1.03 Beta** |
| **Phase** | **2** — App shell (rail + context bar + permanent map + panels) |
| **Based on** | 1.02 Beta (HuntContext) |
| **Test site** | https://test-offline-seven.vercel.app (if linked) |
| **Production** | https://regslayer.com (Hunt-Slayer — unchanged) |

## Phase 2 (this tag)

- Left **rail**: Plan · Map · Conditions · Regs · Hunt log · Party · Offline · Settings
- **Context bar**: date / weapon / area chips + status badge (reads HuntContext)
- **Permanent map** canvas (Leaflet never remounted when switching views)
- Docked **panel** (~340px) hosts existing Plan + Conditions sections as-is; Regs / Log / Party use lightweight hosts (full migration in Phase 3)
- Map rail item collapses the panel for full-canvas work

## Phase 1

- `window.HuntContext` dual-synced with legacy globals
- Map mounts on boot; Link Current Hunt State removed

## Local preview

```bash
python -m http.server 8080
# http://localhost:8080/
```

Hard-refresh after deploy so the service worker picks up the new shell cache.

## Notes for agents

- Prefer editing **TestOffline** for experiments unless asked to promote to Hunt-Slayer.
- **Never push restructure work to Hunt-Slayer** unless the user explicitly asks.
- Bump `SHELL_CACHE` in `sw.js` when shipping shell asset changes.

## Version badge

In-app: **V1.03 Beta** (`APP_VERSION = '1.03-beta'`).
