# Three-minute Windows demo

## Before entering the room

- Run `scripts/Test.ps1` on the target Windows computer.
- Rehearse `scripts/Start-SynapseDesk.ps1 -Demo`; the bundled repo deliberately includes stale endpoint documentation and a circular import.
- For live tracking, install dependencies/model ahead of time, verify camera index/backend, and start the service without `-Demo`. Start the camera worker in another terminal.
- Use Win+P → Extend, move Edge/Chrome onto the projector, enter fullscreen, and perform four-point calibration. Keep camera and projector fixed. Press H to hide controls.
- If using an LLM, download and warm the chosen local model first. The baseline works without it; do not describe deterministic-only analysis as model reasoning.

## 0:00–0:30 — show the messy input

“SynapseDesk turns contradictory repository evidence into a workbench we can manipulate on the table. This version runs entirely on a Windows laptop.” Show the fixture README claiming `/v1/users`, then its `/v2/users` implementation. Load that repo or use the already-running demo.

## 0:30–1:15 — show the agent's action

Display the evidence panel: stale route candidates and the users/repository import cycle. Explain that each claim points to a source file and line. The agent has produced `graph.json` and `triage-report.json` and dispatched the validated graph to the projection. If enabled, show the local model's suggestions separately from static facts.

## 1:15–2:15 — interact

Pinch to pick up a module and release to place it. Press W, select a source and destination, and show the animated amber connection. This creates a proposed pipeline artifact without executing or rewriting an unknown codebase. Mouse interaction is available if camera calibration needs recovery.

## 2:15–2:45 — demonstrate degraded input

With live tracking, remove the hand or stop the camera worker: the gesture releases and status becomes lost/stale. In demo mode, choose “Hand lost” or “Stale camera frame.” Keep the simulator label visible when using simulated data. This is graceful input degradation, not a hardware emergency stop.

## 2:45–3:00 — close on what was executed

“The agent transformed unstructured repository evidence into a validated graph and an auditable report; we spatially edited and saved a proposed pipeline. The Windows service, hand tracking, and projection run locally.” Show `.runtime/pipeline.json` and the report. Do not claim Windows timing certification, a QNX implementation, or an integrated Rox SDK.
