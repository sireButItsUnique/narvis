import copy
import json
import os
import shutil
from pathlib import Path
import secrets
import threading
import time
from laptop_hand_tracking.gestures import GestureGate
from laptop_hand_tracking.spatial import SpatialFilter
from repo_triage_agent.analyze import from_source, ident
from repo_triage_agent.reasoner import reason
from repo_triage_agent.provider import from_config, ProviderError
from repo_triage_agent import workingcopy
from repo_triage_agent.adapters import adapter_for
from .contracts import validate_graph
from .store import Store


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_suffix(path.suffix+".tmp")
    temp.write_text(json.dumps(value,indent=2,allow_nan=False),encoding="utf-8")
    temp.replace(path)


class State:
    def __init__(self, runtime, demo=False, model=None, endpoint="", model_name=""):
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
        self.endpoint = endpoint or os.environ.get("SYNASEDESK_ENDPOINT", "")
        self.model_name = model_name or os.environ.get("SYNASEDESK_MODEL", "")
        self.provider = from_config(self.endpoint, self.model_name)
        self.stop = threading.Event()
        self.analysis = None
        self.tasks = {}
        self.cancel_flags = set()
        # SQLite is authoritative; legacy JSON stays as export. Restore on restart.
        self.store = Store(self.runtime)
        restored = self.store.latest()
        if restored is None and self.store.migrate_legacy_graph(self.runtime):
            restored = self.store.latest()
        if restored is not None:
            self.graph, self.revision, self.job = restored["graph"], restored["rev"], restored["job"]

    def snapshot(self):
        with self.lock:
            return dict(tracking=self.gate.snapshot(),spatial=self.spatial.snapshot(),revision=self.revision,
                        job=dict(self.job),demo=self.demo,demo_fault=self.demo_fault)

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

    def _run_task(self, task_id):
        task = self.store.get_task(task_id)
        if task is None:
            return
        detail = task["detail"]
        if task_id in self.cancel_flags:
            detail["error"] = "cancelled before start"
            self.store.update_task(task_id, "cancelled", detail)
            return
        try:
            evidence = ""
            if detail.get("node_id"):
                try:
                    info = self.explain_node(detail["node_id"])
                    evidence = json.dumps(info["node"])[:2000]
                except ValueError:
                    evidence = ""
            # Bounded retries live inside the provider; explicit errors surface.
            text = self.provider.complete([
                {"role": "system", "content": "Propose a scoped code change. Cite evidence paths. Return a short proposal."},
                {"role": "user", "content": json.dumps({"task": detail["description"], "evidence": evidence})[:4000]}])
            if task_id in self.cancel_flags:
                detail["proposal"] = text[:4000]
                self.store.update_task(task_id, "cancelled", detail)
                return
            snapshot = Path(detail["snapshot"])
            res = workingcopy.write_file(snapshot, "PROPOSAL.md", text[:20000])
            detail["proposal"] = text[:4000]
            detail["checkpoints"].append(res)
            adapter = adapter_for(".py")
            checks = adapter.checks() if adapter else []
            detail["test_output"] = workingcopy.run_checks(snapshot, checks)
            try:
                new_graph = from_source(snapshot)
                detail["graph_delta"] = {"nodes": len(new_graph["nodes"]), "findings": len(new_graph["findings"])}
            except Exception as e:
                detail["graph_delta"] = {"reindex_error": str(e)[:300]}
            self.store.update_task(task_id, "complete", detail)
        except ProviderError as e:
            detail["error"] = str(e)[:500]
            detail["recoverable_checkpoint"] = detail.get("checkpoint")
            self.store.update_task(task_id, "error", detail)
        except Exception as e:
            detail["error"] = f"{type(e).__name__}: {str(e)[:400]}"
            detail["recoverable_checkpoint"] = detail.get("checkpoint")
            self.store.update_task(task_id, "error", detail)

    def cancel_task(self, task_id):
        self.cancel_flags.add(task_id)
        task = self.store.get_task(task_id)
        if task is None:
            raise ValueError("unknown task")
        if task["status"] == "running":
            detail = task["detail"]
            detail["cancel_requested"] = True
            self.store.update_task(task_id, "running", detail)
        return self.store.get_task(task_id)

    def rollback_task(self, task_id):
        task = self.store.get_task(task_id)
        if task is None:
            raise ValueError("unknown task")
        detail = task["detail"]
        snapshot = Path(detail.get("snapshot", ""))
        rolled_back = False
        if snapshot.exists():
            proposal = snapshot / "PROPOSAL.md"
            if proposal.exists():
                proposal.unlink()
                rolled_back = True
        detail["checkpoints"].append({"checkpoint": time.time(),
            "diff": "", "rollback": rolled_back,
            "message": "proposal removed" if rolled_back else "nothing to roll back, checkpoint intact"})
        self.store.update_task(task_id, task["status"], detail)
        return self.store.get_task(task_id)

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
