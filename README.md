# REG SLAYER — TestOffline **V1.02 Beta**

Field / experimental mirror of the production Hunt-Slayer app for the **context + canvas** restructure. Production (regslayer.com / Hunt-Slayer) is **not** affected by this repo.

| | |
|---|---|
| **Version** | `1.02-beta` · badge **V1.02 Beta** |
| **Phase** | **1** — HuntContext state extraction |
| **Based on** | 1.01 Beta snapshot of Hunt-Slayer 6.2 features |
| **Test site** | https://test-offline-seven.vercel.app (if linked) |
| **Production** | https://regslayer.com (Hunt-Slayer — unchanged) |

## Phase 1 (this tag)

- `window.HuntContext` — single source of truth for date / weapon / land / location / distance origin
- Legacy globals dual-synced so existing rules/UI keep working
- Map mounts on app load (`ensureMap` at boot); placeholder no longer gates on weapon pick
- “Link Current Hunt State” removed — trips always save current hunt context when present

## What this is

- Full multi-file app: `index.html`, `offline-engine.js`, `auth-sync.js`, `party-maps.js`, `sw.js`, `icons/`, `vendor/leaflet/`
- Same Supabase **HuntSlayer** project as production (use **test accounts** when experimenting)
- Offline map packs, pin/tool icons, shared maps / party presence

## Local preview

```bash
python -m http.server 8080
# http://localhost:8080/
```

## Notes for agents

- Prefer editing **TestOffline** for experiments unless asked to promote to Hunt-Slayer.
- **Never push restructure work to Hunt-Slayer** unless the user explicitly asks.
- Pin/tool icon pipeline: [`docs/PIN_AND_TOOL_ICONS.md`](docs/PIN_AND_TOOL_ICONS.md)
- Bump `SHELL_CACHE` in `sw.js` when shipping shell asset changes.

## Version badge

In-app: **V1.02 Beta** (`APP_VERSION = '1.02-beta'`).
