# Vendored frontend builds (Option C: Python app)

Users never run npm. Devs build React (when the tripwire trips) and vendor output here:

- `npm run build` in `frontend/` emits to `../synapsedesk/vendored/react/` (see `vite.config.ts`)
- Python serves it at `/vendored/*` with no npm step (`synapsedesk/server.py`)
- Vanilla `web_ar_canvas/public/` remains the default UI until `frontend/TRIPWIRE.md` conditions hit
- Missing build returns explicit JSON: "react build not vendored; vanilla UI active"
