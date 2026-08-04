# REG SLAYER — TestOffline **V1.01 Beta**

Field / experimental mirror of the production Hunt-Slayer app at the time of the **context + canvas** restructure kickoff.

| | |
|---|---|
| **Version** | `1.01-beta` · badge **V1.01 Beta** |
| **Based on** | Hunt-Slayer production snapshot (party share, GPS default, toolbar spacing, offline packs) |
| **Test site** | https://test-offline-seven.vercel.app (if linked) |
| **Production** | https://regslayer.com (Hunt-Slayer — unchanged by this tag) |

## What this is

- Full multi-file app: `index.html`, `offline-engine.js`, `auth-sync.js`, `party-maps.js`, `sw.js`, `icons/`, `vendor/leaflet/`
- Same Supabase **HuntSlayer** project as production (use test accounts when experimenting)
- Offline map packs, pin/tool icons, shared maps / party presence

## Local preview

```bash
python -m http.server 8080
# http://localhost:8080/
```

## Notes for agents

- Prefer editing **TestOffline** for experiments unless asked to promote to Hunt-Slayer.
- Pin/tool icon pipeline: [`docs/PIN_AND_TOOL_ICONS.md`](docs/PIN_AND_TOOL_ICONS.md)
- Bump `SHELL_CACHE` in `sw.js` when shipping shell asset changes.

## Version badge

In-app: **V1.01 Beta** (`APP_VERSION = '1.01-beta'`).
