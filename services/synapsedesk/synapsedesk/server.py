"""Loopback-only Windows service. HTTP + latest-state SSE avoids UDP/socket bridges."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import socket
import threading
from urllib.parse import urlsplit

PUBLIC = Path(__file__).resolve().parent.parent/"web_ar_canvas"/"public"
VENDORED = Path(__file__).resolve().parent/"vendored"
ASSETS = {"/":("index.html","text/html; charset=utf-8"),
          "/display":("display.html","text/html; charset=utf-8"),
          "/app.js":("app.js","text/javascript; charset=utf-8"),
          "/homography.mjs":("homography.mjs","text/javascript; charset=utf-8"),
          "/style.css":("style.css","text/css; charset=utf-8")}


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port, state):
        self.state = state
        self.clients = threading.BoundedSemaphore(24)
        self.streams = threading.BoundedSemaphore(4)
        super().__init__(("127.0.0.1",port),Handler)

    def process_request(self, request, client_address):
        if not self.clients.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request,client_address)
        except Exception:
            self.clients.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request,client_address)
        finally:
            self.clients.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "SynapseDesk/0.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format, *args):
        # High-rate camera posts are intentionally quiet.
        if self.command != "POST" or self.path != "/api/tracking":
            super().log_message(format,*args)

    def allowed(self):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}",f"localhost:{port}"}
        if self.headers.get("Host") not in hosts:
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {"http://"+h for h in hosts}

    def headers_out(self,status,content_type,length=None):
        self.send_response(status)
        self.send_header("Content-Type",content_type)
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("X-Frame-Options","DENY")
        self.send_header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
        if length is not None:
            self.send_header("Content-Length",str(length))
        self.end_headers()

    def json(self,value,status=200):
        data=json.dumps(value,separators=(',',':'),allow_nan=False).encode()
        self.headers_out(status,"application/json",len(data))
        self.wfile.write(data)

    def do_GET(self):
        if not self.allowed():
            self.json({"error":"invalid host or origin"},403)
            return
        parts=urlsplit(self.path)
        path=parts.path
        if path=="/api/health":
            self.json(dict(status="ok",service="synapsedesk",version=1))
        elif path=="/api/session":
            self.json(dict(token=self.server.state.token,demo=self.server.state.demo))
        elif path=="/api/graph":
            with self.server.state.lock:
                self.json(dict(graph=self.server.state.graph,revision=self.server.state.revision))
        elif path=="/api/events":
            try:
                query=dict(q.split("=",1) for q in parts.query.split("&") if "=" in q) if parts.query else {}
                since=int(query.get("since","0"))
            except ValueError:
                self.json({"error":"since must be an integer"},400)
                return
            with self.server.state.lock:
                self.json(dict(events=self.server.state.events_since(since),revision=self.server.state.revision))
        elif path=="/api/state":
            self.json(self.server.state.snapshot())
        elif path=="/api/provider/status":
            self.json(self.server.state.provider_status())
        elif path=="/api/provider/test":
            try:
                self.json(self.server.state.test_provider())
            except ValueError as e:
                self.json({"error":str(e)},400)
        elif path=="/api/agent/tasks":
            self.json({"tasks":self.server.state.store.list_tasks()})
        elif path=="/api/positions":
            self.json({"positions":self.server.state.get_positions()})
        elif path.startswith("/api/agent/tasks/"):
            rest=path[len("/api/agent/tasks/"):].split("/")
            try:
                tid=int(rest[0])
            except ValueError:
                self.json({"error":"invalid task id"},400)
                return
            task=self.server.state.store.get_task(tid)
            if task is None:
                self.json({"error":"unknown task"},404)
                return
            if len(rest)==2 and rest[1]=="patch":
                self.json({"id":tid,"patch":self.server.state.task_patch(tid)})
                return
            if len(rest)==2 and rest[1]=="conversation":
                self.json(self.server.state.task_conversation(tid))
                return
            if len(rest)==1:
                self.json(task)
                return
            self.json({"error":"not found"},404)
        elif path=="/events":
            self.events()
        elif path in ASSETS:
            filename,mime=ASSETS[path]
            data=(PUBLIC/filename).read_bytes()
            self.headers_out(200,mime,len(data))
            self.wfile.write(data)
        elif path.startswith("/vendored/"):
            # React build output vendored by devs; users never run npm.
            # Missing build is an explicit tripwire state, not a silent 404.
            target=(VENDORED/path[len("/vendored/"):]).resolve()
            if VENDORED.resolve() not in target.parents or not target.is_file():
                self.json({"error":"react build not vendored; vanilla UI active (see frontend/TRIPWIRE.md)"},404)
                return
            mime="text/html; charset=utf-8" if target.suffix==".html" else \
                 "text/javascript; charset=utf-8" if target.suffix==".js" else \
                 "text/css; charset=utf-8" if target.suffix==".css" else "application/octet-stream"
            data=target.read_bytes()
            self.headers_out(200,mime,len(data))
            self.wfile.write(data)
        else:
            self.json({"error":"not found"},404)

    def events(self):
        if not self.server.streams.acquire(blocking=False):
            self.json({"error":"too many projection clients"},503)
            return
        try:
            self.headers_out(200,"text/event-stream")
            while not self.server.state.stop.is_set():
                data=json.dumps(self.server.state.snapshot(),separators=(',',':'),allow_nan=False)
                self.wfile.write(("event: state\ndata: "+data+"\n\n").encode())
                self.wfile.flush()
                self.server.state.stop.wait(1/30)
        except (BrokenPipeError,ConnectionResetError,socket.timeout,ConnectionAbortedError):
            pass
        finally:
            self.server.streams.release()

    def do_POST(self):
        if not self.allowed() or not secrets.compare_digest(self.headers.get("X-Synapse-Token",""),self.server.state.token):
            self.json({"error":"invalid session or origin"},403)
            return
        try:
            if self.headers.get_content_type()!="application/json" or self.headers.get("Transfer-Encoding"):
                raise ValueError("JSON with Content-Length required")
            length=int(self.headers.get("Content-Length","0"))
            if not 0<length<=64000:
                raise ValueError("request exceeds 64 KB budget")
            data=json.loads(self.rfile.read(length))
            if not isinstance(data,dict):
                raise ValueError("JSON object required")
            state=self.server.state
            path=urlsplit(self.path).path
            if path=="/api/tracking":
                if state.demo:
                    raise ValueError("stop demo mode before connecting a camera")
                with state.lock:
                    state.gate.ingest(data)
            elif path=="/api/spatial":
                with state.lock:
                    state.spatial.ingest(data)
            elif path=="/api/analyze":
                state.start_analysis(data.get("source"))
            elif path=="/api/wires":
                if not isinstance(data.get("source"),str) or not isinstance(data.get("target"),str):
                    raise ValueError("source and target must be strings")
                state.wire(data["source"],data["target"],data.get("revision"))
            elif path=="/api/bounds":
                state.set_bounds(data)
            elif path=="/api/positions":
                if not isinstance(data.get("positions"),dict):
                    raise ValueError("positions must be an object")
                self.json(state.set_positions(data["positions"]))
                return
            elif path=="/api/demo":
                if not state.demo or data.get("fault") not in ("none","lost","stale","boundary"):
                    raise ValueError("invalid demo fault")
                with state.lock:
                    state.demo_fault=data["fault"]
            elif path=="/api/agent/explain":
                if not isinstance(data.get("node_id"),str):
                    raise ValueError("node_id must be a string")
                self.json(state.explain_node(data["node_id"]))
                return
            elif path=="/api/agent/tasks":
                task_id=state.create_agent_task(data.get("source",""),data.get("description",""),data.get("node_id","") or "")
                self.json({"id":task_id})
                return
            elif path.startswith("/api/agent/tasks/"):
                rest=path[len("/api/agent/tasks/"):].split("/")
                try:
                    tid=int(rest[0])
                except ValueError:
                    raise ValueError("invalid task id")
                if len(rest)==2 and rest[1]=="cancel":
                    self.json(state.cancel_task(tid))
                    return
                if len(rest)==2 and rest[1]=="rollback":
                    self.json(state.rollback_task(tid))
                    return
                raise ValueError("not found")
            else:
                self.json({"error":"not found"},404)
                return
            self.json({"ok":True})
        except (ValueError,TypeError,KeyError) as exc:
            self.json({"error":str(exc)},400)
        except OSError:
            self.json({"error":"local I/O failed"},500)
