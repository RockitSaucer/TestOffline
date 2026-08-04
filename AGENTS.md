# TestOffline agent notes

**Current snapshot:** **V1.01 Beta** (`APP_VERSION = '1.01-beta'`)  
Snapshot of Hunt-Slayer production features at restructure kickoff (context + canvas shell work starts from this baseline on TestOffline unless otherwise directed).

## Pin & tool icons

**Full procedure:** [`docs/PIN_AND_TOOL_ICONS.md`](docs/PIN_AND_TOOL_ICONS.md)

1. Sources: `Desktop/HuntApp/button icons/Layers naked/` (pins), `Tool Icons/` (toolbar)
2. Run: `python tools/process_pin_icons.py` / `process_tool_icons.py`
3. Wire `PIN_ICON_CATALOG` in `index.html`
4. Bump `SHELL_CACHE` in `sw.js`

## Scope

Work stays in **TestOffline** unless the user explicitly asks to promote into Hunt-Slayer / production.
