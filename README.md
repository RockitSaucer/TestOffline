# REG SLAYER — TestOffline **V1.10 Beta**

Full **context + canvas** restructure on the TestOffline experimental repo.  
**Production (regslayer.com / Hunt-Slayer) is not affected.**

| | |
|---|---|
| **Version** | `1.10-beta` · badge **V1.10 Beta** |
| **Phases** | 1–6 complete |
| **Test site** | https://test-offline-seven.vercel.app (if linked) |
| **Production** | https://regslayer.com (Hunt-Slayer — unchanged) |

## What shipped

1. **HuntContext** — single source of truth for date / weapon / land / location / distance origin  
2. **Shell** — left rail, context bar, permanent map canvas, docked panel  
3. **Migration** — Plan + Conditions panels; Regulations verdict; Hunt log filters; Party = My Maps; Settings diet  
4. **Map tools** — floating top-right tool cluster + tool status strip  
5. **Mobile** — bottom rail, context summary strip, More sheet, sheet-style panel  
6. **Polish** — “Today’s rules”, Conditions empty state + skeleton, a11y labels on shell chrome  

## Local preview

```bash
python -m http.server 8080
# http://localhost:8080/
```

Hard-refresh after deploy so the service worker picks up `reg-slayer-testoffline-1.10-v1`.

## Notes for agents

- Prefer editing **TestOffline** for experiments unless asked to promote to Hunt-Slayer.
- **Never push restructure work to Hunt-Slayer** unless the user explicitly asks.
