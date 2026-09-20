# Three-minute Windows demo

## Before entering the room

- Run `scripts/Test.ps1` on the target Windows computer.
- Rehearse `scripts/Start-SynapseDesk.ps1 -Demo`; the bundled repo deliberately includes stale endpoint documentation and a circular import.
- For live tracking, install dependencies/model ahead of time, verify camera index/backend, and start the service without `-Demo`. Start the camera worker in another terminal.
- Use Win+P → Extend, move Edge/Chrome onto the projector, and open `/display` there (or press H on the editor page for the same chrome-free view). Enter fullscreen and perform four-point calibration. Keep camera and projector fixed.
- Placements are saved server-side, so lay the graph out once beforehand: `/display` follows the editor within about 1.5 s.
- If using an LLM, download and warm the chosen local model first. The baseline works without it; do not describe deterministic-only analysis as model reasoning.
- Decide beforehand whether the agent gate is open. Without `-ModelEndpoint`/`-ModelName` and `SYNAPSEDESK_API_KEY`, **Implement** deliberately fails with "live-agent gate blocked" — that is a legitimate thing to show, but do not present it as a working implementation.

## 0:00–0:30 — show the messy input

“SynapseDesk turns contradictory repository evidence into a workbench we can manipulate on the table. This version runs entirely on a Windows laptop.” Show the fixture README claiming `/v1/users`, then its `/v2/users` implementation. Load that repo or use the already-running demo.

## 0:30–1:15 — show the agent's action

Display the evidence panel: stale route candidates and the users/repository import cycle. Explain that each claim points to a source file and line. The agent has produced `graph.json` and `triage-report.json` and dispatched the validated graph to the projection. If enabled, show the local model's suggestions separately from static facts.

## 1:15–1:45 — ask the agent

Select a node and press **Explain selection**: the answer comes from the index alone — evidence path, line, and
edges — with no model call. Use **Search all components** to show that every indexed node stays reachable even
when the canvas only draws what fits. If the gate is open, run **Implement** on a scoped change and show the
task's proposal, its checks, and its graph delta; say plainly that it wrote into a working copy, not the repo.

## 1:45–2:15 — interact

Pinch to pick up a module and release to place it. Press W, select a source and destination, and show the animated amber connection. This creates a proposed pipeline artifact without executing or rewriting an unknown codebase. Mouse interaction is available if camera calibration needs recovery.

## 2:15–2:45 — demonstrate degraded input

With live tracking, remove the hand or stop the camera worker: the gesture releases and status becomes lost/stale. In demo mode, choose “Hand lost” or “Stale camera frame.” Keep the simulator label visible when using simulated data. This is graceful input degradation, not a hardware emergency stop.

## 2:45–3:00 — close on what was executed

“The agent transformed unstructured repository evidence into a validated graph and an auditable report; we spatially edited and saved a proposed pipeline. The Windows service, hand tracking, and projection run locally.” Show `.runtime/pipeline.json` and the report, and note that the layout, revisions, and tasks are in `.runtime/synapsedesk.db` — closing the window and reopening it restores the desk. Do not claim Windows timing certification, a QNX implementation, or an integrated Rox SDK.
