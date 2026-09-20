# Local service protocol, version 1

All traffic stays on `127.0.0.1:8765`. No static IP, Cat6, UDP listener, firewall exception, or remote controller is needed. `--port` changes the loopback port. The service checks Host/Origin, refuses cross-site browser requests, does not enable CORS, and requires an `X-Synapse-Token` on mutations. A same-origin client obtains its per-process token from `GET /api/session`. The token is a browser request boundary, not isolation from other processes running as your Windows user.

| Endpoint | Method | Contract |
|---|---|---|
| `/api/health` | GET | Process readiness; camera/model readiness is separate |
| `/api/session` | GET | `{token, demo}` |
| `/api/state` | GET | `{tracking, spatial, revision, job, demo}` |
| `/events` | GET | SSE `event: state`, same state payload at 30 Hz; maximum four streams |
| `/api/graph` | GET | `{revision, graph: {version:1, nodes, edges, findings, meta}}` |
| `/api/analyze` | POST | `{source: "C:\\projects\\repo"}` or an HTTPS git URL; one job at a time |
| `/api/tracking` | POST | Camera packet below; rejected in demo mode |
| `/api/spatial` | POST | Registered depth packet below; independent of hand tracking |
| `/api/wires` | POST | `{source: "node-id", target: "node-id", revision: 1}`; stale revision rejected |
| `/api/bounds` | POST | `{xmin:0, xmax:1, ymin:0, ymax:1}`; normalized interaction rectangle |
| `/api/demo` | POST | `{fault: "none" | "lost" | "stale" | "boundary"}`; demo mode only |

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

## Graph artifacts

Nodes: `{id, label, kind, evidence:{path,line,parser}}`; kinds are `module`, `function`, `class`, `external`. IDs are stable hashes of source identity. Edges: `{id, source, target, kind, evidence?}`; kinds are `contains`, `imports`, `calls`, `proposed`. External means unresolved/static external reference, not a proven external API call. Findings have `{kind,severity,message,evidence,nodes?}`. Evidence paths are repository-relative.

The schema validator rejects duplicate node/edge IDs, dangling edges, invalid kinds, and oversized graphs (600 nodes / 3,000 edges). The canvas displays up to 90 non-external nodes and reports its visible count; the exported graph retains the full validated result. The file walker bounds scanning to 800 candidate files / 20 MB, skips files over 256 KB with findings, and does not follow symlinks.

Local-model reviews can only annotate existing finding indexes. They never change AST facts, execute commands, write scanned files, or update interaction bounds. Graph publication and each artifact replacement are atomic per file; multiple artifacts are not a transactional database.
