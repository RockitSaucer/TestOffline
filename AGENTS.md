# TestOffline agent notes

## Pin & tool icons (read this before changing map pins or toolbar tools)

**Full procedure:** [`docs/PIN_AND_TOOL_ICONS.md`](docs/PIN_AND_TOOL_ICONS.md)

When the user asks for **new pins**, **more pin icons**, or pin art “like the ones we have,” follow that doc exactly:

1. Sources: `Desktop/HuntApp/button icons/Layers naked/` (unless they give another folder)
2. Run: `python tools/process_pin_icons.py`
3. Wire new entries into `PIN_ICON_CATALOG` in `index.html` from `icons/pins/_catalog.json`
4. Defaults: white disc, natural glyph, body color = image color; no white background; no pin-in-pin
5. Bump `SHELL_CACHE` in `sw.js`

Tool icons: `tools/process_tool_icons.py` + `HuntApp/button icons/Tool Icons/` — same isolation idea; measure/draw yellow, track red, layers larger/thicker light glyph.

## Scope

Work stays in **TestOffline** unless the user explicitly asks to promote into Hunt-Slayer / HuntApp baseline HTML.
