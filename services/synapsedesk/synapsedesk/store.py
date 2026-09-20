"""SQLite persistence. stdlib only, DB is authoritative, JSON artifacts stay as legacy exports."""
import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT, created REAL);
CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, rev INTEGER NOT NULL,
  graph_json TEXT NOT NULL, job_json TEXT NOT NULL, created REAL,
  UNIQUE(project_id, rev));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, rev INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, created REAL);
CREATE TABLE IF NOT EXISTS positions(node_id TEXT PRIMARY KEY, x REAL, y REAL, z REAL, updated REAL);
CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL,
  scope TEXT NOT NULL, messages_json TEXT NOT NULL, updated REAL);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL,
  status TEXT NOT NULL, detail_json TEXT NOT NULL, updated REAL);
"""


class Store:
    def __init__(self, runtime):
        self.path = Path(runtime) / "synapsedesk.db"
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.db.commit()
        if not self.db.execute("SELECT id FROM projects WHERE id=1").fetchone():
            self.db.execute("INSERT INTO projects(id,name,source,created) VALUES(1,'default','',?)", (time.time(),))
            self.db.commit()

    def latest(self):
        row = self.db.execute(
            "SELECT rev, graph_json, job_json FROM revisions WHERE project_id=1 ORDER BY rev DESC LIMIT 1").fetchone()
        if not row:
            return None
        return {"rev": row[0], "graph": json.loads(row[1]), "job": json.loads(row[2])}

    def migrate_legacy_graph(self, runtime):
        """Import existing .runtime/graph.json once, without overwriting it."""
        if self.latest() is not None:
            return False
        legacy = Path(runtime) / "graph.json"
        if not legacy.exists():
            return False
        try:
            graph = json.loads(legacy.read_text(encoding="utf-8"))
            if not isinstance(graph, dict) or graph.get("version") != 1:
                return False
            job = {"status": "complete", "message": "Migrated legacy graph.json"}
            self.save_revision(graph, job, event="legacy.migrate")
            return True
        except (OSError, ValueError):
            return False

    def save_revision(self, graph, job, event="revision", payload=None):
        cur = self.db.execute("SELECT COALESCE(MAX(rev),0)+1 FROM revisions WHERE project_id=1").fetchone()[0]
        self.db.execute("INSERT INTO revisions(project_id,rev,graph_json,job_json,created) VALUES(1,?,?,?,?)",
                        (cur, json.dumps(graph, allow_nan=False), json.dumps(job, allow_nan=False), time.time()))
        self.db.execute("INSERT INTO events(project_id,rev,type,payload,created) VALUES(1,?,?,?,?)",
                        (cur, event, json.dumps(payload or {"rev": cur}, allow_nan=False), time.time()))
        self.db.commit()
        return cur

    def events_since(self, since=0, limit=200):
        rows = self.db.execute(
            "SELECT rev,type,payload,created FROM events WHERE project_id=1 AND rev>? ORDER BY rev ASC LIMIT ?",
            (since, limit)).fetchall()
        return [dict(rev=r[0], type=r[1], payload=json.loads(r[2]), created=r[3]) for r in rows]

    # Tasks: failed tasks stay visible with recoverable checkpoints.
    def create_task(self, detail):
        cur = self.db.execute("INSERT INTO tasks(project_id,status,detail_json,updated) VALUES(1,'running',?,?)",
                              (json.dumps(detail, allow_nan=False), time.time()))
        self.db.commit()
        return cur.lastrowid

    def update_task(self, task_id, status, detail):
        self.db.execute("UPDATE tasks SET status=?, detail_json=?, updated=? WHERE id=? AND project_id=1",
                        (status, json.dumps(detail, allow_nan=False), time.time(), task_id))
        self.db.commit()

    def get_task(self, task_id):
        row = self.db.execute("SELECT id,status,detail_json,updated FROM tasks WHERE id=? AND project_id=1",
                              (task_id,)).fetchone()
        if not row:
            return None
        return {"id": row[0], "status": row[1], "detail": json.loads(row[2]), "updated": row[3]}

    def list_tasks(self, limit=50):
        rows = self.db.execute("SELECT id,status,detail_json,updated FROM tasks WHERE project_id=1 ORDER BY id DESC LIMIT ?",
                               (limit,)).fetchall()
        return [{"id": r[0], "status": r[1], "detail": json.loads(r[2]), "updated": r[3]} for r in rows]

    # Positions persist across refresh/restart; localStorage mirrors for instant paint.
    def get_positions(self):
        rows = self.db.execute("SELECT node_id,x,y,z FROM positions").fetchall()
        return {r[0]: {"x": r[1], "y": r[2], "z": r[3]} for r in rows}

    def set_positions(self, items):
        now = time.time()
        for node_id, p in list(items.items())[:2000]:
            try:
                x, y, z = float(p["x"]), float(p["y"]), float(p.get("z", 0))
            except (KeyError, TypeError, ValueError):
                continue
            if not all(-1 <= v <= 2 for v in (x, y)) or not -10 <= z <= 10:
                continue
            self.db.execute("INSERT INTO positions(node_id,x,y,z,updated) VALUES(?,?,?, ?,?) "
                            "ON CONFLICT(node_id) DO UPDATE SET x=excluded.x,y=excluded.y,z=excluded.z,updated=excluded.updated",
                            (str(node_id)[:240], x, y, z, now))
        self.db.commit()
