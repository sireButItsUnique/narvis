# SynapseDesk — Windows laptop subsystem

A local service for turning repository evidence into a projected engineering graph, with camera-based hand interaction. **The target is a Windows computer. There is no QNX, Raspberry Pi controller, GPIO relay, or physical safety claim in this version.** Existing `rig/` pages remain independent.

## Run the demo on Windows

Install 64-bit Python 3.12 with its `py` launcher. Open PowerShell in this directory:

```powershell
.\scripts\Setup.ps1
.\scripts\Start-SynapseDesk.ps1 -Demo
```

Open [the local workbench](http://127.0.0.1:8765) in Edge or Chrome. No Node.js, camera, model download, or cloud account is needed for the demo. It analyzes the included contradictory repository and displays a **SIMULATED HAND**. Ctrl+C stops the service. If organizational PowerShell policy prevents scripts, use the equivalent commands below; no execution-policy change is necessary:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m synapsedesk serve --demo
```

Installation may need internet for packaging dependencies; the installed demo and local repository analysis run offline. This is a foreground service subsystem, not a registered Windows Service Control Manager service. Keep the source checkout in place: editable installation uses its adjacent web assets.

## Modules

| Module | Responsibility |
|---|---|
| `synapsedesk/` | Loopback HTTP service, versioned contracts, latest-state SSE at 30 Hz, bounded requests, graph publication, session token |
| `laptop_hand_tracking/` | Optional Windows camera worker, local MediaPipe palm/landmark inference, pinch gating, simulator, calibrated depth-point filtering |
| `web_ar_canvas/` | Dependency-free HTML5 Canvas, skeletal HUD, homography calibration, pinch/mouse dragging, animated wires, evidence panel |
| `repo_triage_agent/` | Python AST analysis, source/doc reconciliation, import-cycle detection, optional local LLM review, validated graph artifacts |
| `scripts/`, `config/`, `docs/` | PowerShell launchers, service manifest, API and pitch runbook |

```mermaid
flowchart LR
    Camera[USB or laptop camera] --> Capture[Latest-frame capture]
    Capture --> MP[Local MediaPipe worker]
    MP -->|HTTP landmarks| Service[Windows Python service]
    Repo[Local repository or HTTPS git URL] --> Agent[Evidence-first triage agent]
    LLM[Optional local Ollama model] -.-> Agent
    Agent -->|Validated graph and findings| Service
    Depth[Optional registered depth adapter] -->|Desk-space samples| Service
    Service -->|Latest state SSE| Canvas[Browser canvas]
    Canvas --> Projector[Extended Windows projector display]
    Canvas -->|Proposed graph connections| Service
    Service --> Artifacts[graph.json / triage-report.json / pipeline.json]
```

## Use a real camera

Stop the demo, then install the optional camera dependencies and save the model described in [models/README.md](models/README.md):

```powershell
.\scripts\Setup.ps1 -Tracking
.\scripts\Start-SynapseDesk.ps1 -Repo 'C:\projects\my-repo'
```

In a second PowerShell window, from this directory:

```powershell
.\scripts\Start-Tracking.ps1 -Camera 0 -Backend dshow
```

Use `-Camera 1` for another camera or `-Backend msmf` if DirectShow fails. Windows **Settings → Privacy & security → Camera** must allow desktop camera apps. The default is unmirrored; `-Mirror` changes the camera coordinate frame and requires recalibration. The service refuses real camera packets while demo mode is active.

The capture thread continuously drains frames; inference consumes the most recent frame. The worker uses MediaPipe Tasks in VIDEO mode with one hand and 0.65 detection/presence/tracking thresholds. Returned handedness scores are deliberately not reported as tracking confidence. Pinch is Euclidean distance between landmarks 4 and 8 with aspect compensation and on/off hysteresis (0.035/0.055 image-width units).

Three accepted frames are needed before gestures activate. A missing hand, out-of-workspace landmark, or stale acquisition disables gestures. The service expires frames after 250 ms including the worker's reported processing age. The browser independently releases a pinch if state delivery stops for 250 ms. This is a UI control policy, not deterministic timing or personnel protection.

## Calibrate the projector

1. Use Windows **Win+P → Extend**. Move the browser to the projector display, set its final resolution/scaling, then click **Fullscreen** or press **F**.
2. Press **C**. Place the index fingertip on each projected cross and press **Space** on the laptop keyboard to capture its camera coordinate. Four points determine the homography. Degenerate input is rejected.
3. Press **H** for a clean projection. **H** restores controls; **Esc** cancels calibration or an in-progress connection.
4. Pinch over a node to drag it; release to place it. Mouse dragging also works for rehearsal. **W** switches to wiring: pinch/click the source, release, then select a different destination.

Camera coordinates and projector positions remain normalized; pixels are computed at render time. Homography is a planar mapping: a hand raised above the desk incurs parallax. Z is relative hand depth, not absolute desk height. Calibrate at the working plane. Recalibrate after moving the camera/projector, changing mirror mode, or changing display geometry. Calibration is stored in that browser's local storage; positions are session-local. Wiring saves a **proposed** pipeline, not executable repository edits.

## Repository agent and Rox track

Enter a local folder or an explicit HTTPS git URL and choose **Analyze**. Git must be installed for URLs. The agent scans without importing code, running builds, installing repository dependencies, or executing hooks/submodules. Symlinks and common generated/vendor directories are excluded; file and graph budgets fail explicitly or produce coverage findings.

Implemented evidence extraction supports **Python ASTs**: modules, classes, functions, imports, resolvable direct calls, literal route decorators, and docstrings. Other supported source extensions are inventoried as modules and explicitly marked as lacking AST coverage. Dynamic dispatch, route prefixes, generated routes, reflection, and Python import side effects are not inferred. Unmatched documentation is a review candidate, never proof of a dead endpoint.

The agent executes concrete actions: it validates and publishes the architecture graph, produces an evidence report, and updates the browser. Gesture-created connections persist as a separate proposed pipeline. Each successful scan replaces the graph and proposed connections; export `.runtime/pipeline.json` before rescanning if you want to retain a proposal.

To add probabilistic conflict interpretation, install Ollama and a model that fits your laptop, then start with its installed model name:

```powershell
.\scripts\Start-SynapseDesk.ps1 -Repo 'C:\projects\my-repo' -Model 'YOUR_INSTALLED_MODEL'
```

The adapter calls only `http://127.0.0.1:11434/api/chat`. It sends bounded evidence summaries, requests structured JSON, validates finding references, and labels reasoning as unverified suggestions. Model failure still publishes the deterministic graph with an error annotation. Without `-Model`, triage is deterministic and makes no claim to have called an LLM. Repository text is untrusted data and cannot create executable actions or change workspace constraints.

**No Rox-specific API/SDK is integrated:** none was supplied. `reasoner.py` is the replaceable provider boundary. This provides a working agent workflow for the stated track concept, not a claim of organizer compliance or a fabricated Rox integration.

## Optional Kinect/depth input

`POST /api/spatial` accepts at most 1,000 **already calibrated** `[normalized desk X, normalized desk Y, height metres]` points. The filter removes invalid/out-of-range input, plane noise, and isolated cells; recent obstacle cells appear in amber. This is visualization only.

A Windows Kinect capture/registration adapter is **not included**. Its implementation depends on Kinect v1 versus v2, the installed SDK/driver, USB hardware, and desk calibration. Do not send raw camera-space depth to this endpoint. See [the protocol](docs/PROTOCOL.md) for the adapter contract. No Raspberry Pi Camera Module 3 interface is assumed on Windows; use a camera exposed by an installed Windows capture backend.

## Artifacts and testing

Outputs are under `.runtime/` (gitignored): `graph.json`, `triage-report.json`, `pipeline.json` after wiring, and `interaction-bounds.json` after a bounds update. A new process starts a fresh session; these artifacts are outputs, not automatically restored configuration. Scanned repositories are not modified.

```powershell
.\scripts\Test.ps1
# Analyze without the browser:
.\.venv\Scripts\python.exe -m synapsedesk analyze 'C:\projects\my-repo' --out .runtime\export.json
```

Python tests cover gesture loss/reacquisition, invalid frames, stream ownership, AST calls and conflicts, graph validation, model reference validation, spatial noise filtering, HTTP boundaries, and persisted actions. Optional Node tests cover homography mathematics; Node is not a runtime dependency. Hardware camera capture, projector alignment, Windows PowerShell launchers, and local-model performance require validation on your Windows machine.

See [the three-minute runbook](docs/PITCH.md) and [service contracts](docs/PROTOCOL.md).
