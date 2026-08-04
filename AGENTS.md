# TestOffline agent notes

**Current snapshot:** **V1.03 Beta** (`APP_VERSION = '1.03-beta'`)  
Restructure work lives **only** in this repo. Do not modify Hunt-Slayer / regslayer.com unless the user asks.

## Restructure phases

| Phase | Status | Focus |
|-------|--------|--------|
| 1 | Done (1.02) | `HuntContext`, dual-sync globals, `ensureMap` on boot, remove Link Hunt State |
| **2** | **Done (1.03)** | Rail + context bar + permanent map + docked panels; Plan/Conditions mounted as-is |
| 3 | Pending | Migration cleanup, Settings diet, Party extraction, modal policy |
| 4 | Pending | Map tools — floating cluster, status strip |
| 5 | Pending | Mobile — bottom tabs polish, summary strip, sheets |
| 6 | Pending | Polish — copy, empty states, a11y |

Stop for user review after each phase.

## App shell (Phase 2)

- `window.AppShell` / `setShellView(view)` — views: `plan` | `map` | `conditions` | `regs` | `log` | `party`
- Map view collapses `#shell-panel`; other views open the panel and show the matching `.shell-view`
- Context bar chips jump to Plan and scroll to date/weapon/area sections
- `#shell-map-host` always holds the map card (do not destroy Leaflet when switching views)
- `fitDesktopMapHeight` prefers `#shell-map-host` / `#shell-stage`

## HuntContext (Phase 1)

- Global: `window.HuntContext`
- Fields: `date`, `weapon`, `land`, `locationId`, `distOrigin { mode, lat, lng, label }`
- Legacy `selectedDate`, `selectedWeapon`, etc. remain dual-synced

## Pin & tool icons

**Full procedure:** [`docs/PIN_AND_TOOL_ICONS.md`](docs/PIN_AND_TOOL_ICONS.md)

## Scope

Work stays in **TestOffline** unless the user explicitly asks to promote into Hunt-Slayer / production.
