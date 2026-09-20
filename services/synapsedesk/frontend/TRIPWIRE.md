# React tripwire (agreed Q14)

Stay on vanilla `web_ar_canvas/` until one of these becomes hacky:

1. Multiselect / undo-redo / saved layouts in vanilla
2. Searchable, viewport-rendered large graph (no truncation)
3. Monaco source/diff inspection
4. Three.js hologram sync (editor ↔ `/display`)

When tripped: grow `frontend/src/` (React Flow + Monaco + Three.js, already pinned in
`frontend/package.json`), run `npm run build` (emits to `synapsedesk/vendored/react/`),
Python keeps serving at `/vendored/*`. Users still only run `Setup.ps1` / `Start-SynapseDesk.ps1`.
