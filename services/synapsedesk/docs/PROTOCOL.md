# Local service protocol, version 1

All traffic stays on `127.0.0.1:8770`. The port is 8770 rather than 8765 so this service can run beside the HoloModel server, which owns 8765 in this repository. No static IP, Cat6, UDP listener, firewall exception, or remote controller is needed. `--port` changes the loopback port. The service checks Host/Origin, refuses cross-site browser requests, does not enable CORS, and requires an `X-Synapse-Token` on mutations. A same-origin client obtains its per-process token from `GET /api/session`. The token is a browser request boundary, not isolation from other processes running as your Windows user.

| Endpoint | Method | Contract |
|---|---|---|
| `/api/health` | GET | Process readiness; camera/model readiness is separate |
| `/api/session` | GET | `{token, demo}` |
| `/api/state` | GET | `{tracking, spatial, revision, job, demo}` |
| `/events` | GET | SSE `event: state`, same state payload at 30 Hz; maximum eight streams |
| `/api/graph` | GET | `{revision, graph: {version:1, nodes, edges, findings, meta}}` |
| `/api/analyze` | POST | `{source: "C:\\projects\\repo"}` or an HTTPS git URL; one job at a time |
| `/api/tracking` | POST | Camera packet below; rejected in demo mode |
| `/api/spatial` | POST | Registered depth packet below; independent of hand tracking |
| `/api/wires` | POST | `{source: "node-id", target: "node-id", revision: 1}`; stale revision rejected |
| `/api/bounds` | POST | `{xmin:0, xmax:1, ymin:0, ymax:1}`; normalized interaction rectangle |
| `/api/demo` | POST | `{fault: "none" | "lost" | "stale" | "boundary"}`; demo mode only |
| `/api/events` | GET | `?since=<revision>`; the durable revision log, at most 200 entries |
| `/api/positions` | GET | `{positions: {node-id: {x, y, z}}}` saved node placements |
| `/api/positions` | POST | `{positions: {node-id: {x, y, z}}}`; at most 2,000 entries, returns `{saved}` |
| `/api/provider/status` | GET | `{name, endpoint, model, live}` for the agent provider |
| `/api/provider/test` | GET | Probes the configured endpoint; 400 while the gate is blocked |
| `/api/agent/explain` | POST | `{node_id}` → the indexed node, its citations, and its edges |
| `/api/agent/tasks` | GET | `{tasks: [...]}`, newest first, at most 50 |
| `/api/agent/tasks` | POST | `{source, description, node_id?}` → `{id}`; local directory only |
| `/api/agent/tasks/{id}` | GET | `{id, status, detail, updated}` |
| `/api/agent/tasks/{id}/patch` | GET | Concatenated unified diffs, at most 40 KB |
| `/api/agent/tasks/{id}/conversation` | GET | `{id, messages}` — the persisted provider exchange |
| `/api/agent/tasks/{id}/cancel` | POST | Cooperative cancel; only a `running` task is affected |
| `/api/agent/tasks/{id}/rollback` | POST | Undoes the task's writes inside its working copy |
| `/` and `/display` | GET | Editor page and chrome-free projection page, same bundle |
| `/vendored/*` | GET | Vendored React build; explicit 404 JSON while none is vendored |
| `/hologram` | GET | The rig view: the current level drawn into the working volume |
| `/api/rig` | GET/POST | Physical measurements of the rig, in the units you measured them in |
| `/api/volume` | GET/POST | The working volume in centimetres that content is laid out inside |
| `/api/hand-frame` | GET/POST | How your tracker's coordinates become rig centimetres. Set once |
| `/api/hands` | POST | Hand landmarks from your tracker; refused in demo mode |
| `/api/eye` | POST | Head position, already registered to `rig_cm` |
| `/api/agent/ask` | POST | `{utterance, trail?}` → one grounded verb; text in, no audio |
| `/api/voice/status` | GET | `{name, live, reason, voice_id}` for speech |
| `/api/voice/voices` | GET | The voices your ElevenLabs account can use |
| `/api/voice/listen` | POST | **Audio bytes**, not JSON: `Content-Type: audio/*`, at most 2 MB |
| `/api/voice/say` | POST | `{text}` → `audio/mpeg` |

POSTs require `Content-Type: application/json`, Content-Length, and at most 64 KB. Success is `{ok:true}`; errors use `{error:"..."}` with 400/403/404/500 status. Accepted analysis returns immediately; observe `job.status` (`running`, `complete`, `error`). Graph revision advances on publication and wiring. Invalid analysis leaves the last valid graph available.

## Camera worker

```json
{
  "version": 1,
  "stream": "unique-worker-session-id",
  "seq": 1,
  "age_ms": 21.8,
  "aspect": 1.333333,
  "present": false,
  "simulated": false,
  "landmarks": []
}
```

For a present hand, `landmarks` must contain exactly 21 finite `[x,y,z]` arrays in MediaPipe order. X/Y are image normalized; Z uses relative image-width depth. `age_ms` measures acquisition-to-submission delay using the worker's monotonic clock. No cross-process wall-clock synchronization is assumed. Sequence numbers increase per stream. A second stream cannot take ownership until the first has been silent for 500 ms. Duplicate/reordered frames do not refresh freshness. Use a new stream ID when restarting capture.

The service derives pinch; it never trusts an upstream pinch boolean. It publishes an `enabled` interaction state, reason, current landmarks, and computed pinch. Coordinate samples are held in memory only. The browser drops gestures independently on transport loss.

## Optional depth adapter

```json
{
  "version": 1,
  "frame": "desk_normalized_xy_z_m",
  "age_ms": 12,
  "points": [[0.21, 0.21, 0.10], [0.22, 0.22, 0.12], [0.23, 0.23, 0.11]]
}
```

The adapter must fit the desk plane, transform camera points into desk coordinates, and subsample to at most 1,000 points. Values are finite; X/Y must lie on the normalized desk to survive filtering. Height between 0.03 and 1 metre is retained. At least three samples in a 0.05-by-0.05 cell form a visual obstacle; median height suppresses isolated depth noise. Frames older than 250 ms produce no cells; input expires after 500 ms. The adapter contract does not implement a Kinect driver, infer depth from hand Z, or authorize an actuator.

## Persistence

`.runtime/synapsedesk.db` (SQLite, WAL) is authoritative. It holds graph revisions, an append-only event log,
node positions, agent tasks, and the agent conversation per task. A restart restores the latest revision, its
job status, and saved positions; an existing `.runtime/graph.json` from an older build is imported once and
left in place. The JSON files under `.runtime/` remain exports, not inputs. They are written with a temp-file
replace, so each file is individually atomic; several files are not one transaction.

Node positions are shared state: the editor saves a placement about 800 ms after a drag or pinch release, and
`/display` re-reads them every 1.5 s and on every revision change, which is how the two views stay in step.
Calibration stays in that browser's local storage and is never sent to the service.

## Agent tasks

`POST /api/agent/tasks` accepts a **local directory only** — no URL, no file. The service copies the working
tree into `.runtime/workingcopies/task_<id>/`, skipping symlinks, files over 1 MB, and generated directories.
Every subsequent file operation is confined to that copy; the original checkout is never modified.

A task calls the configured provider once, writes `PROPOSAL.md` into the working copy, runs the check commands
of whichever language dominates the copy, and re-indexes it for a graph delta. The check step is the only place
the service executes repository code: analysis never does, but `cargo test` / `npm test` / `python -m unittest`
and friends do. At most five commands run, each capped at 60 seconds, with output truncated to 4 KB per stream. Each write records a checkpoint
with a unified diff and the prior content, so rollback restores it; content over 200 KB is not retained and its
checkpoint reports `restorable: false`. Cancellation is cooperative and is tested between stages — it cannot
interrupt a check already running. A failed task stays visible with its error and a recoverable checkpoint.

Without `--model-endpoint` and `--model-name`, the provider is a stub that refuses every call: the live-agent
gate is blocked and says so rather than pretending to reason. The API key is read from `SYNAPSEDESK_API_KEY`
in the environment (the earlier `SYNASEDESK_` spelling is still accepted) and never appears in a response,
an artifact, or the index.

## The rig, and hands inside it

`/hologram` draws the level you are on into the volume under the acrylic sheet, from where your eye
actually is. The projection maths is `web_ar_canvas/public/rig-geometry.mjs`, vendored verbatim from
`rig/rigtest2` — see [NOTICE](../NOTICE), which records a licence consequence that has not been decided.

`POST /api/rig` carries the measurements. Everything scales off `panel_diagonal_in`: entering a 27 inch
panel as 24 puts the image about 12% out and no trimming fixes it. The volume is then derived from the
rig rather than chosen, and depth is treated as a requirement, not as whatever is left over — filling the
panel first leaves about 2 cm of depth, which reads as a flat picture.

### Connecting a hand tracker

You keep your tracker. Tell the service once how to read its numbers:

```json
POST /api/hand-frame
{"version": 1, "units": "m", "axes": ["x", "y", "-z"], "scale": [1,1,1], "offset": [0,-13,0]}
```

`units` is cm, m, mm or in. `axes` says which of YOUR axes becomes rig X, Y and Z, with a leading minus to
flip one. `offset` is centimetres added last. Then post raw tracker numbers at whatever rate you track at:

```json
POST /api/hands
{"version": 1, "age_ms": 8, "hands": [
  {"label": "right", "thumb_tip": [0.02, 0.01, 0.03], "index_tip": [0.025, 0.01, 0.03]}]}
```

Send the 21 MediaPipe landmarks as `landmarks` if you have them; the extra joints are drawn but never
interpreted, so two fingertips are genuinely enough. A landmark that lands more than 3 m from the desk is
rejected with a message naming the hand frame, rather than dropping a hand somewhere absurd.

**Pinch is not accepted from upstream.** The service derives it from the thumb-index distance in
centimetres, with two thresholds and a settling count, so one tracker's idea of "pinching" cannot change
what the desk does. `scripts/hand_bridge.py` is a working reference; `--demo` posts a circling hand.

Touching decides what a gesture means when the hand is among the cards, and a ray from the eye through the
fingertip takes over when it is not — a finger held below the content would otherwise aim above it. A
pinch that does not move opens a card; one that moves places it. A hand that goes stale, leaves the volume
or disappears disarms rather than keeping its grip.

## Asking

`POST /api/agent/ask` turns one sentence into exactly one verb, against the graph that is loaded.

A grammar answers first — *open X*, *go up*, *take me home*, *explain X*, *find X*, *zoom out*, *list
tasks*, *cancel* — with no model call and therefore no possibility of invention. Only a sentence it does
not recognise reaches the provider, which must answer in a fixed shape that is then checked: an intent
naming a node that does not exist is refused, exactly as a model review citing a nonexistent finding is.

Names are resolved against the index and never guessed. A phrase matching one thing navigates; a phrase
matching several comes back with `ambiguous: true` and the candidates, and nothing moves. A phrase
matching nothing says so. Folders are targets even though the graph has no folder nodes — the levels
derive them, so `intent.directories()` does too.

The verbs are not equal. Reading verbs run. `implement` writes into a working copy and runs that
repository's test command, so it returns `needs_confirmation: true` and a proposal, and **never starts a
task**. Something has to say yes, and a microphone is not a good enough witness for that. Confirming means
`POST /api/agent/tasks` as usual.

## Speech

`/api/voice/*` is ElevenLabs, called from the service so the key is never in a browser. It is **off by
default**: without `SYNAPSEDESK_ELEVENLABS_API_KEY` and a voice id every call refuses and says which is
missing. `GET /api/voice/voices` lists the voices on your account; pass the id with `--voice`.

**This is the one path that leaves the machine.** Analysis never does, the optional reasoner is pinned to
127.0.0.1, and hand and head tracking are yours. Speech is not: audio goes to ElevenLabs to be transcribed
and replies are synthesised there. Turning it on is a deliberate choice and it is written down rather than
buried. Audio is capped at 2 MB per turn, upstream errors are scrubbed of anything key-shaped before they
are returned, and the browser records only while the talk control is held — there is no hot microphone.

## Graph artifacts

Nodes: `{id, label, kind, evidence:{path,line,parser}}`; kinds are `module`, `function`, `class`, `external`. IDs are stable hashes of source identity. Edges: `{id, source, target, kind, evidence?}`; kinds are `contains`, `imports`, `calls`, `proposed`. External means unresolved/static external reference, not a proven external API call. Findings have `{kind,severity,message,evidence,nodes?}`. Evidence paths are repository-relative.

The schema validator rejects duplicate node/edge IDs, dangling edges, invalid kinds, and oversized graphs (600 nodes / 3,000 edges). The canvas displays up to 90 non-external nodes and reports its visible count; the exported graph retains the full validated result. The file walker bounds scanning to 800 candidate files / 20 MB, skips files over 256 KB with findings, and does not follow symlinks.

Local-model reviews can only annotate existing finding indexes. They never change AST facts, execute commands, write scanned files, or update interaction bounds. Graph publication and each artifact replacement are atomic per file; multiple artifacts are not a transactional database.
