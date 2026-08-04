# TestOffline agent notes

**Current snapshot:** **V1.02 Beta** (`APP_VERSION = '1.02-beta'`)  
Restructure work lives **only** in this repo. Do not modify Hunt-Slayer / regslayer.com unless the user asks.

## Restructure phases

| Phase | Status | Focus |
|-------|--------|--------|
| **1** | **Done (1.02)** | `HuntContext`, dual-sync globals, `ensureMap` on boot, remove Link Hunt State, map placeholder |
| 2 | Pending | Shell — rail + context bar + permanent map + panels |
| 3 | Pending | Migration — view cleanup, Settings diet, Party, modals |
| 4 | Pending | Map tools — floating cluster, status strip |
| 5 | Pending | Mobile — bottom tabs, sheets |
| 6 | Pending | Polish — copy, empty states, a11y |

Stop for user review after each phase.

## HuntContext (Phase 1)

- Global: `window.HuntContext`
- Fields: `date`, `weapon`, `land`, `locationId`, `distOrigin { mode, lat, lng, label }`
- API: `setDate` / `setWeapon` / `setLand` / `setLocationId` / `setDistOrigin`, `snapshot`, `subscribe`, `syncFromGlobals`, `syncToGlobals`
- Mutators that write context: `selectDateStep`, `setWeapon`, `setLand`, `selectLocation`, `setDistOriginMode`, GPS boot / `requestDistGps`, `ensureHuntContext`, trip quick-load
- Legacy `selectedDate`, `selectedWeapon`, `selectedLand`, `selectedLocationId`, `distOrigin*` remain dual-synced

## Pin & tool icons

**Full procedure:** [`docs/PIN_AND_TOOL_ICONS.md`](docs/PIN_AND_TOOL_ICONS.md)

1. Sources: `Desktop/HuntApp/button icons/Layers naked/` (pins), `Tool Icons/` (toolbar)
2. Run: `python tools/process_pin_icons.py` / `process_tool_icons.py`
3. Wire `PIN_ICON_CATALOG` in `index.html`
4. Bump `SHELL_CACHE` in `sw.js`

## Scope

Work stays in **TestOffline** unless the user explicitly asks to promote into Hunt-Slayer / production.
