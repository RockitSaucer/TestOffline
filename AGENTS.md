# TestOffline agent notes

**Current snapshot:** **V1.10 Beta** (`APP_VERSION = '1.10-beta'`)  
Restructure phases **1–6 complete** on TestOffline only. Do not modify Hunt-Slayer unless the user asks.

## Architecture (post-restructure)

| Piece | API / location |
|-------|----------------|
| Hunt context | `window.HuntContext` (dual-synced with `selectedDate` / `selectedWeapon` / …) |
| Navigation | `window.AppShell` / `setShellView(view)` — `plan` `map` `conditions` `regs` `log` `party` |
| Map host | `#shell-map-host` — Leaflet never remounted on view change |
| Party / My Maps | `#view-party` holds map-management IDs (`set-all-maps-list`, create/join, etc.) |
| Settings | Account · Defaults · Offline (tools always on; section-hide removed) |
| Tool chrome | Floating cluster via `.shell-v2 .map-bottom-bar`; `#map-tool-status-strip` |

## Phases

| Phase | Version | Status |
|-------|---------|--------|
| 1 HuntContext | 1.02 | Done |
| 2 Shell | 1.03 | Done |
| 3–6 migration, tools, mobile, polish | **1.10** | **Done** |

## Pin & tool icons

[`docs/PIN_AND_TOOL_ICONS.md`](docs/PIN_AND_TOOL_ICONS.md)

## Scope

Work stays in **TestOffline** unless the user explicitly asks to promote into Hunt-Slayer / production.
