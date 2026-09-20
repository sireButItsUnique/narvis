import copy
import json
import os
from pathlib import Path
import secrets
import threading
import time
from laptop_hand_tracking.gestures import GestureGate
from laptop_hand_tracking.spatial import SpatialFilter
from laptop_hand_tracking.volume_hands import VolumeHands
from repo_triage_agent.analyze import from_source, ident
from repo_triage_agent.reasoner import reason
from repo_triage_agent.provider import from_config, ProviderError
from repo_triage_agent import workingcopy
from repo_triage_agent.adapters import adapter_for
from repo_triage_agent import intent as intents
from .voice import from_config as voice_from_config, VoiceError
from .contracts import (DEFAULT_HAND_FRAME, DEFAULT_RIG, DEFAULT_VOLUME, validate_eye,
                        validate_graph, validate_hand_frame, validate_rig, validate_view,
                        validate_volume)
from .store import Store


def env(name, default=""):
    """SYNAPSEDESK_<NAME>, falling back to the historical misspelling."""
    return os.environ.get("SYNAPSEDESK_"+name) or os.environ.get("SYNASEDESK_"+name) or default


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_suffix(path.suffix+".tmp")
    temp.write_text(json.dumps(value,indent=2,allow_nan=False),encoding="utf-8")
    temp.replace(path)


class State:
    def __init__(self, runtime, demo=False, model=None, endpoint="", model_name="", voice_id=""):
        self.runtime = Path(runtime)
        self.runtime.mkdir(parents=True,exist_ok=True)
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.gate = GestureGate()
        self.spatial = SpatialFilter()
        self.graph = dict(version=1,nodes=[],edges=[],findings=[],meta={})
        self.revision = 0
        self.job = dict(status="idle",message="Choose a repository to begin")
        self.demo, self.demo_fault, self.model = demo, "none", model
        self.endpoint = endpoint or env("ENDPOINT")
        self.model_name = model_name or env("MODEL")
        self.provider = from_config(self.endpoint, self.model_name)
        self.stop = threading.Event()
        self.analysis = None
        self.view = []
        self.eye = None
        self.eye_received = 0.
        self.voice = voice_from_config(voice_id)
        self.heard = []
        # Rig geometry, unlike the graph, survives a restart: it describes the desk, not the session.
        self.rig = self._restore("rig.json", validate_rig, DEFAULT_RIG)
        self.volume = self._restore("volume.json", validate_volume, DEFAULT_VOLUME)
        self.hand_frame = self._restore("hand-frame.json", validate_hand_frame, DEFAULT_HAND_FRAME)
        self.hands = VolumeHands(self.volume)
        self.hands.set_volume(self.volume, [0., -self.rig["anchor_drop_cm"], 0.])
        self.tasks = {}
        self.cancel_flags = set()
        # SQLite is authoritative; legacy JSON stays as export. Restore on restart.
        self.store = Store(self.runtime)
        restored = self.store.latest()
        if restored is None and self.store.migrate_legacy_graph(self.runtime):
            restored = self.store.latest()
        if restored is not None:
            self.graph, self.revision, self.job = restored["graph"], restored["rev"], restored["job"]

    def _restore(self, name, validate, default):
        try:
            return validate(json.loads((self.runtime/name).read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return dict(default)

    def snapshot(self):
        with self.lock:
            return dict(tracking=self.gate.snapshot(),spatial=self.spatial.snapshot(),revision=self.revision,
                        job=dict(self.job),demo=self.demo,demo_fault=self.demo_fault,view=list(self.view),
                        volume=dict(self.volume),rig=dict(self.rig),eye=self.eye_snapshot(),
                        hands=self.hands.snapshot())

    def graph_snapshot(self):
        with self.lock:
            return copy.deepcopy(self.graph)

    def events_since(self, since=0):
        return self.store.events_since(since)

    def start_analysis(self, source):
        if not isinstance(source,str) or not source.strip():
            raise ValueError("provide a repository path or HTTPS URL")
        with self.lock:
            if self.analysis and self.analysis.is_alive():
                raise ValueError("analysis is already running")
            self.job = dict(status="running",message="Reading source evidence")
            self.analysis = threading.Thread(target=self._analyze,args=(source,),daemon=True)
            self.analysis.start()

    def _analyze(self, source):
        try:
            graph = from_source(source)
            if self.model:
                with self.lock:
                    self.job = dict(status="running",message="Reviewing conflicts with local model")
                try:
                    graph["reasoning"] = reason(graph,self.model)
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    graph["reasoning"] = dict(error=str(exc)[:300],provenance="llm_unavailable")
            validate_graph(graph)
            with self.lock:
                # SQLite authoritative; JSON artifacts remain as legacy exports.
                atomic_json(self.runtime/"graph.json", graph)
                atomic_json(self.runtime/"triage-report.json", dict(meta=graph["meta"],findings=graph["findings"],reasoning=graph.get("reasoning")))
                atomic_json(self.runtime/"pipeline.json", dict(version=1,edges=[]))
                job = dict(status="complete",message=f"Published {len(graph['nodes'])} nodes; {len(graph['findings'])} findings")
                self.revision = self.store.save_revision(graph, job, event="analysis.complete",
                    payload={"nodes": len(graph["nodes"]), "findings": len(graph["findings"])})
                self.graph, self.job = graph, job
        except Exception as exc:
            with self.lock:
                self.job = dict(status="error",message=f"{type(exc).__name__}: {str(exc)[:400]}")

    def wire(self, source, target, revision):
        with self.lock:
            if revision != self.revision:
                raise ValueError("graph changed; retry against the current graph")
            ids = {n["id"] for n in self.graph["nodes"]}
            if source not in ids or target not in ids or source == target:
                raise ValueError("select two different graph nodes")
            edge = dict(id="p:"+ident(source+target),source=source,target=target,kind="proposed")
            if any(e["id"]==edge["id"] for e in self.graph["edges"]):
                return
            graph = copy.deepcopy(self.graph)
            graph["edges"].append(edge)
            validate_graph(graph)
            atomic_json(self.runtime/"graph.json",graph)
            atomic_json(self.runtime/"pipeline.json",dict(version=1,edges=[e for e in graph["edges"] if e["kind"]=="proposed"]))
            self.revision = self.store.save_revision(graph, self.job, event="graph.wire",
                payload={"edge": edge["id"], "source": source, "target": target})
            self.graph = graph

    def set_view(self, trail):
        """Which level the desk is showing. Not persisted: it is where you are looking, not state."""
        with self.lock:
            self.view = validate_view(trail)
            return {"view": list(self.view)}

    def eye_snapshot(self, now=None):
        """Head position with the age the client should judge it by, not the age the tracker claimed."""
        if self.eye is None:
            return None
        now = time.monotonic() if now is None else now
        age = (now - self.eye_received) * 1000 + self.eye["age_ms"]
        return dict(self.eye, age_ms=round(age, 1))

    def set_eye(self, packet, now=None):
        with self.lock:
            self.eye = validate_eye(packet)
            self.eye_received = time.monotonic() if now is None else now
            return {"ok": True}

    def set_hand_frame(self, frame):
        """How the tracker's own coordinates become rig centimetres. Set once; it describes the room."""
        with self.lock:
            self.hand_frame = validate_hand_frame(frame)
            atomic_json(self.runtime/"hand-frame.json", self.hand_frame)
            return dict(self.hand_frame)

    def set_rig(self, rig):
        with self.lock:
            self.rig = validate_rig(rig)
            atomic_json(self.runtime/"rig.json", self.rig)
            # The reach test is in rig coordinates, so it has to follow the anchor when the rig moves.
            self.hands.set_volume(self.volume, [0., -self.rig["anchor_drop_cm"], 0.])
            return dict(self.rig)

    def set_volume(self, volume):
        with self.lock:
            self.volume = validate_volume(volume)
            atomic_json(self.runtime/"volume.json", self.volume)
            self.hands.set_volume(self.volume, [0., -self.rig["anchor_drop_cm"], 0.])
            return dict(self.volume)

    def set_bounds(self,bounds):
        with self.lock:
            self.gate.set_bounds(bounds)
            atomic_json(self.runtime/"interaction-bounds.json",self.gate.bounds)

    # Agent: explain with citations (local, no credential) + snapshot tasks.
    def explain_node(self, node_id):
        with self.lock:
            nodes = {n["id"]: n for n in self.graph["nodes"]}
            node = nodes.get(node_id)
            if node is None:
                raise ValueError("unknown node")
            incoming = [e for e in self.graph["edges"] if e["target"] == node_id][:10]
            outgoing = [e for e in self.graph["edges"] if e["source"] == node_id][:10]
            ev = node.get("evidence", {})
            return {"node": node, "citations": [ev] if ev.get("path") else [],
                    "incoming": incoming, "outgoing": outgoing,
                    "provenance": "indexed_evidence"}

    # ---- spoken interaction ------------------------------------------------------------------
    # An utterance becomes exactly one verb. The grammar answers first and cannot invent; only what it
    # does not recognise reaches the provider, and that answer is checked against the loaded graph before
    # anything happens. Reading verbs run. The one verb that writes is proposed and never executed here:
    # a microphone is not a good enough witness for starting a task that runs a repository's test command.
    def ask(self, utterance, trail=None):
        if not isinstance(utterance, str) or not utterance.strip():
            raise ValueError("say something")
        if len(utterance) > 600:
            raise ValueError("utterance too long")
        parsed = intents.parse(utterance)
        if parsed is None:
            parsed = self._ask_provider(utterance)
        return self._ground(parsed, trail if isinstance(trail, list) else list(self.view))

    def _ask_provider(self, utterance):
        try:
            text = self.provider.complete([
                {"role": "system", "content": intents.SYSTEM_PROMPT},
                {"role": "user", "content": utterance[:600]}])
        except ProviderError as exc:
            return dict(verb="describe", argument="", source="unavailable",
                        say=f"I did not understand that, and the language model is unavailable: {exc}",
                        utterance=utterance)
        try:
            start, end = text.index("{"), text.rindex("}") + 1
            value = intents.validate_model_intent(json.loads(text[start:end]))
        except (ValueError, KeyError):
            return dict(verb="describe", argument="", source="unparsed",
                        say="I did not catch that.", utterance=utterance)
        value["utterance"] = utterance
        return value

    def _paths(self, nodes):
        return {n["id"]: (n["evidence"] or {}).get("path", "") if n["kind"] == "module"
                else (n.get("scope") or {}).get("module", "") for n in nodes}

    def _ground(self, parsed, trail):
        """Turn a verb into something the desk can do, against the graph that is actually loaded."""
        with self.lock:
            nodes = list(self.graph["nodes"])
        verb, argument = parsed["verb"], parsed.get("argument", "")
        out = dict(verb=verb, argument=argument, source=parsed.get("source", "grammar"),
                   utterance=parsed.get("utterance", ""), trail=list(trail), acts=False,
                   needs_confirmation=False, say=parsed.get("say", ""), candidates=[])
        paths = self._paths(nodes)
        here = trail[-1] if trail else ""

        if verb in ("ascend", "root"):
            out["trail"] = [] if verb == "root" else list(trail[:-1])
            out["say"] = out["say"] or ("Back to the system view." if verb == "root" else "Going up.")
            return out
        if verb == "zoom":
            out["zoom"] = argument if argument in ("in", "out", "fit") else "fit"
            out["say"] = out["say"] or f"Zooming {out['zoom']}."
            return out
        if verb == "tasks":
            tasks = self.store.list_tasks(limit=5)
            out["tasks"] = [{"id": t["id"], "status": t["status"]} for t in tasks]
            out["say"] = out["say"] or (f"{len(tasks)} task{'s' if len(tasks) != 1 else ''}: " +
                                        ", ".join(f"{t['id']} {t['status']}" for t in tasks)
                                        if tasks else "No tasks.")
            return out
        if verb == "cancel":
            running = [t for t in self.store.list_tasks(limit=10) if t["status"] == "running"]
            if not running:
                out["say"] = out["say"] or "Nothing is running."
                return out
            self.cancel_task(running[0]["id"])
            out["cancelled"] = running[0]["id"]
            out["say"] = out["say"] or f"Cancelling task {running[0]['id']}."
            return out
        if verb == "describe":
            out["say"] = out["say"] or self._describe(here, nodes)
            return out

        if verb == "search":
            found = intents.resolve(intents.normalise(argument), nodes, paths, limit=6)
            out["candidates"] = [self._candidate(c, paths) for c in found]
            out["say"] = out["say"] or (f"{len(found)} match{'es' if len(found) != 1 else ''} for {argument}."
                                        if found else f"Nothing indexed matches {argument}.")
            return out

        if verb == "implement":
            # The argument is a DESCRIPTION of a change, not the name of a node: resolving "add a retry
            # around the provider" as if it named one thing produces a confident, wrong target.
            out["acts"] = True
            out["needs_confirmation"] = True
            focus_node = self._node_at(here, nodes)
            out["proposal"] = {"description": argument, "node_id": focus_node["id"] if focus_node else "",
                               "scope": here or "the repository root"}
            out["say"] = out["say"] or (
                f"I can propose that against {out['proposal']['scope']}. Confirm and I will open a task.")
            return out

        if verb in ("navigate", "explain"):
            # Navigation may land on a folder; explaining cannot, because a folder has no evidence.
            searchable = nodes + (intents.directories(paths) if verb == "navigate" else [])
            target = None
            if argument:
                found = intents.resolve(intents.normalise(argument), searchable, paths, limit=4)
                out["candidates"] = [self._candidate(c, paths) for c in found]
                # An ambiguous name asks rather than guessing: two things with nearly equal claim to a
                # phrase is not a decision a microphone should make. The test is a RATIO, not a
                # difference — a clear leader at 0.9 against 0.7 is clear, and at 0.3 against 0.1 it is
                # not, though the gap is the same.
                if found and (len(found) == 1 or
                              (found[0]["score"] >= .5 and found[0]["score"] >= found[1]["score"] * 1.25)):
                    target = found[0]["node"]
                elif found:
                    out["ambiguous"] = True
                    out["say"] = out["say"] or ("Which one: " +
                        ", ".join(c["node"]["label"] for c in found[:3]) + "?")
                    return out
                else:
                    out["say"] = out["say"] or f"I have nothing indexed called {argument}."
                    return out
            if verb == "navigate":
                if not target:
                    out["say"] = out["say"] or "Where to?"
                    return out
                out["trail"] = self._trail_to(target, paths)
                out["say"] = out["say"] or f"Opening {target['label']}."
                return out
            if verb == "explain":
                node = target or self._node_at(here, nodes)
                if node is None:
                    out["say"] = out["say"] or "Point at something first."
                    return out
                explained = self.explain_node(node["id"])
                out["explain"] = explained
                out["node_id"] = node["id"]
                evidence = (explained["citations"] or [{}])[0]
                where = f"{evidence.get('path', '')}:{evidence.get('line', '')}".strip(":")
                out["say"] = out["say"] or (
                    f"{node['label']} is a {node['kind']}"
                    + (f" in {where}" if where else "")
                    + f", with {len(explained['incoming'])} callers and {len(explained['outgoing'])} calls out.")
                return out
            # implement: proposed, never started from here.
            out["acts"] = True
            out["needs_confirmation"] = True
            out["proposal"] = {"description": argument, "node_id": target["id"] if target else "",
                               "scope": here or "the repository root"}
            out["say"] = out["say"] or (
                f"I can propose that against {out['proposal']['scope']}. Confirm and I will open a task.")
            return out

        out["say"] = out["say"] or "I did not catch that."
        return out

    def _candidate(self, found, paths):
        node = found["node"]
        return {"id": node["id"], "label": node["label"], "kind": node["kind"],
                "path": paths.get(node["id"], ""), "score": found["score"],
                "node": {"id": node["id"], "label": node["label"], "kind": node["kind"]}}

    def _node_at(self, here, nodes):
        if not here:
            return None
        for node in nodes:
            if node["id"] == here:
                return node
        paths = self._paths(nodes)
        for node in nodes:
            if node["kind"] == "module" and paths.get(node["id"]) == here:
                return node
        return None

    def _trail_to(self, node, paths):
        if node.get("directory"):
            parts = [p for p in node["directory"].split("/") if p]
            return ["/".join(parts[:i + 1]) for i in range(len(parts))][:8]
        path = paths.get(node["id"], "")
        parts = [p for p in path.split("/") if p]
        trail = ["/".join(parts[:i + 1]) for i in range(len(parts))]
        if node["kind"] != "module":
            trail.append(node["id"])
        return trail[:8]

    def _describe(self, here, nodes):
        if not here:
            return (f"The system view, {len({(self._paths(nodes).get(n['id']) or '').split('/')[0] for n in nodes if n['kind'] == 'module'})}"
                    f" top level folders, {len(nodes)} indexed nodes.")
        node = self._node_at(here, nodes)
        if node is None:
            return f"Looking at {here}."
        return f"{node['label']}, a {node['kind']}."

    def voice_status(self):
        status = dict(self.voice.status())
        status["provider"] = self.provider.name
        return status

    def listen(self, audio, content_type):
        """Audio in, transcript and intent out. The one path that leaves this machine."""
        heard = self.voice.transcribe(audio, content_type)
        answer = self.ask(heard["text"]) if heard["text"] else dict(
            verb="describe", say="I did not hear anything.", argument="", source="silence",
            utterance="", trail=list(self.view), acts=False, needs_confirmation=False, candidates=[])
        answer["heard"] = heard["text"]
        with self.lock:
            self.heard = ([{"text": heard["text"], "verb": answer["verb"]}] + self.heard)[:20]
        return answer

    def say(self, text):
        return self.voice.speak(text)

    def provider_status(self):
        return {"name": self.provider.name, "endpoint": getattr(self.provider, "endpoint", ""),
                "model": getattr(self.provider, "model", ""), "live": self.provider.name != "stub"}

    def test_provider(self):
        try:
            return self.provider.test_connection()
        except ProviderError as e:
            raise ValueError(str(e))

    def create_agent_task(self, source, description, node_id=""):
        if not isinstance(source, str) or not source.strip() or "://" in source:
            raise ValueError("implement requires a local repository path")
        src = Path(source).expanduser().resolve()
        if not src.is_dir():
            raise ValueError("repository must be a directory")
        detail = {"source": str(src), "description": description or "", "node_id": node_id,
                  "checkpoints": [], "test_output": [], "graph_delta": {}, "proposal": ""}
        task_id = self.store.create_task(detail)
        snapshot = self.runtime / "workingcopies" / f"task_{task_id}"
        workingcopy.snapshot_source(src, snapshot)
        detail["snapshot"] = str(snapshot)
        detail["checkpoint"] = {"graph_revision": self.revision, "created": time.time()}
        self.store.update_task(task_id, "running", detail)
        t = threading.Thread(target=self._run_task, args=(task_id,), daemon=True)
        t.start()
        return task_id

    def _finish_task(self, task_id, status, detail):
        self.cancel_flags.discard(task_id)
        self.store.update_task(task_id, status, detail)

    def _checks_for(self, snapshot):
        """Run the checks of whichever language dominates the snapshot, not always Python's."""
        counts = {}
        for path in Path(snapshot).rglob("*"):
            suffix = path.suffix.lower()
            if path.is_file() and suffix and adapter_for(suffix) is not None:
                counts[suffix] = counts.get(suffix, 0) + 1
        if not counts:
            return "", []
        suffix = max(sorted(counts), key=counts.get)
        adapter = adapter_for(suffix)
        return (adapter.name if adapter else ""), (adapter.checks() if adapter else [])

    def _run_task(self, task_id):
        task = self.store.get_task(task_id)
        if task is None:
            return
        detail = task["detail"]
        if task_id in self.cancel_flags:
            detail["error"] = "cancelled before start"
            self._finish_task(task_id, "cancelled", detail)
            return
        try:
            evidence = ""
            if detail.get("node_id"):
                try:
                    info = self.explain_node(detail["node_id"])
                    evidence = json.dumps(info["node"])[:2000]
                except ValueError:
                    evidence = ""
            messages = [
                {"role": "system", "content": "Propose a scoped code change. Cite evidence paths. Return a short proposal."},
                {"role": "user", "content": json.dumps({"task": detail["description"], "evidence": evidence})[:4000]}]
            # Bounded retries live inside the provider; explicit errors surface.
            text = self.provider.complete(messages)
            self.store.append_conversation(f"task:{task_id}", messages + [{"role": "assistant", "content": text[:20000]}])
            if task_id in self.cancel_flags:
                detail["proposal"] = text[:4000]
                self._finish_task(task_id, "cancelled", detail)
                return
            snapshot = Path(detail["snapshot"])
            res = workingcopy.write_file(snapshot, "PROPOSAL.md", text[:20000])
            detail["proposal"] = text[:4000]
            detail["checkpoints"].append(res)
            if task_id in self.cancel_flags:
                # Checks can run for minutes; do not start them after a cancel.
                self._finish_task(task_id, "cancelled", detail)
                return
            adapter_name, checks = self._checks_for(snapshot)
            detail["checks_adapter"] = adapter_name
            detail["test_output"] = workingcopy.run_checks(snapshot, checks)
            if task_id in self.cancel_flags:
                self._finish_task(task_id, "cancelled", detail)
                return
            try:
                new_graph = from_source(str(snapshot))
                detail["graph_delta"] = {"nodes": len(new_graph["nodes"]), "findings": len(new_graph["findings"])}
            except Exception as e:
                detail["graph_delta"] = {"reindex_error": str(e)[:300]}
            self._finish_task(task_id, "complete", detail)
        except ProviderError as e:
            detail["error"] = str(e)[:500]
            detail["recoverable_checkpoint"] = detail.get("checkpoint")
            self._finish_task(task_id, "error", detail)
        except Exception as e:
            detail["error"] = f"{type(e).__name__}: {str(e)[:400]}"
            detail["recoverable_checkpoint"] = detail.get("checkpoint")
            self._finish_task(task_id, "error", detail)

    def cancel_task(self, task_id):
        task = self.store.get_task(task_id)
        if task is None:
            raise ValueError("unknown task")
        if task["status"] != "running":
            # Terminal tasks cannot be cancelled; do not leak a flag for them.
            return task
        self.cancel_flags.add(task_id)
        detail = task["detail"]
        detail["cancel_requested"] = True
        self.store.update_task(task_id, "running", detail)
        return self.store.get_task(task_id)

    def rollback_task(self, task_id):
        """Undo this task's writes newest-first, restoring prior content inside the snapshot."""
        task = self.store.get_task(task_id)
        if task is None:
            raise ValueError("unknown task")
        detail = task["detail"]
        snapshot = Path(detail.get("snapshot", ""))
        results = []
        if snapshot.is_dir():
            for checkpoint in reversed([c for c in detail.get("checkpoints", []) if c.get("path")]):
                results.append(workingcopy.restore_checkpoint(snapshot, checkpoint))
        detail["checkpoints"] = [c for c in detail.get("checkpoints", []) if not c.get("path")]
        detail["rollback"] = {"checkpoint": time.time(), "results": results,
                              "restored": sum(1 for r in results if r["restored"]),
                              "message": "working copy restored" if any(r["restored"] for r in results)
                                         else "nothing to roll back, snapshot intact"}
        self.store.update_task(task_id, task["status"], detail)
        return self.store.get_task(task_id)

    def task_conversation(self, task_id):
        if self.store.get_task(task_id) is None:
            raise ValueError("unknown task")
        return {"id": task_id, "messages": self.store.get_conversation(f"task:{task_id}")}

    def task_patch(self, task_id):
        task = self.store.get_task(task_id)
        if task is None:
            raise ValueError("unknown task")
        return "\n".join(c.get("diff", "") for c in task["detail"].get("checkpoints", []))[:40000]

    def get_positions(self):
        return self.store.get_positions()

    def set_positions(self, items):
        if not isinstance(items, dict):
            raise ValueError("positions must be an object")
        self.store.set_positions(items)
        return {"saved": len(items)}
