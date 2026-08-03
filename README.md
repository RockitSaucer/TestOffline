# REG SLAYER — TestOffline

**Experimental offline build** for low / no cell service.  
**Does not replace** the production [Hunt-Slayer](https://github.com/RockitSaucer/Hunt-Slayer) app.

Based on Hunt App **4.5**, with offline features for field testing only.

## What this adds

| Feature | Behavior |
|--------|----------|
| **Service Worker** | Caches app shell (HTML, Leaflet, logos) so a **return visit** works with no network |
| **Bundled Leaflet** | `vendor/leaflet/` — map engine no longer requires unpkg CDN offline |
| **Save map offline (2 mi)** | On **orange map-dot menu** → downloads basemap tiles for a **2-mile radius** |
| **Custom draw areas** | Geometry already stored on device; after **Save shape**, optional 2 mi tile download; also on custom-area popup |
| **Weather disk cache** | Last successful weather per spot/date kept up to ~7 days for offline reuse |
| **Public lands** | Same 30-day `localStorage` cache as production (unchanged pattern) |
| **Connection banner** | Shows when offline or while downloading map packs |
| **Settings → Display** | Offline status + **Clear offline map tiles** (does not wipe pins/areas) |

## What stays on the device (not cookies)

- Browser **`localStorage`**: settings, pins, stands, custom areas, tracks, past hunts, public lands blob, offline pack metadata, weather disk cache  
- **Cache API** (via Service Worker): app shell + map tiles you download  
- **Not** a large native app install; clearing site data removes it  

## How to try offline

1. Open the site **with signal** (GitHub Pages or local server).  
2. Pick date + weapon so the map loads once.  
3. Tap a map spot (orange dot menu) → **Save map offline (2 mi)**.  
4. Or **Draw** a custom area → Save → confirm tile download when prompted.  
5. Optional: **Add to Home Screen** (PWA manifest).  
6. Turn on airplane mode → reload → planner, saved shapes, and cached map area should still work.

> Service workers require **https** (or `localhost`). Opening `index.html` as a `file://` page will **not** register the SW.

## Local preview

```bash
# From this folder (Python 3)
python -m http.server 8080
# then open http://localhost:8080/
```

## Custom pins & toolbar icons

How pins and tool icons are built (background strip, catalog, defaults) is documented for agents and future work:

- **[`docs/PIN_AND_TOOL_ICONS.md`](docs/PIN_AND_TOOL_ICONS.md)** — full pipeline  
- **[`AGENTS.md`](AGENTS.md)** — short agent checklist  
- Scripts: `tools/process_pin_icons.py`, `tools/process_tool_icons.py`

## Production note

**Hunt-Slayer** (and any `to deploy/Hunt_app4.x` folders) are intentionally **unchanged**.  
Promote offline features into a real version only after you are happy with field tests.

## Version badge

In-app: **V4.5-OT** (`APP_VERSION = 4.5-offline-test`).

## Cloud (Supabase) — testing multi-map + live location

TestOffline is wired to the same **HuntSlayer** Supabase project as production (auth + private/shared maps + `party_presence`).

| Piece | Detail |
|--------|--------|
| Auth / maps | Settings → **My Maps** |
| Live location | Blue pulse button next to Current Location (shared map only) |
| Scripts | `auth-sync.js`, `party-maps.js` (+ CDN Supabase JS) |

**Use test accounts** (e.g. `testoffline1` / `testoffline2`), not real hunting accounts, so experiments don’t clutter production maps.

Quick multi-user check:

1. Open https://test-offline-seven.vercel.app (or local server) on two browsers.  
2. Create two accounts → Settings → My Maps → Create shared map → Join with code on the other device.  
3. Drop a pin on A → appears on B after sync.  
4. Toggle share location on A → B sees the marker; click for distance.
