import argparse
import json
from pathlib import Path
import threading
from urllib.request import urlopen
from .server import Server
from .state import State, atomic_json

ROOT = Path(__file__).resolve().parent.parent
# 8765 belongs to the HoloModel server in this repository; keep this service clear of it.
DEFAULT_PORT = 8770


def build_parser():
    parser=argparse.ArgumentParser(description="SynapseDesk Windows laptop subsystem")
    commands=parser.add_subparsers(dest="command",required=True)
    serve=commands.add_parser("serve",help="start the local projection + triage service")
    serve.add_argument("--port",type=int,default=DEFAULT_PORT)
    serve.add_argument("--demo",action="store_true")
    serve.add_argument("--repo",help="optional repository to analyze at startup")
    serve.add_argument("--runtime",type=Path,default=ROOT/".runtime")
    serve.add_argument("--model",help="optional installed local Ollama model name")
    serve.add_argument("--model-endpoint",default="",help="Chat Completions-compatible base URL (live-agent gate)")
    serve.add_argument("--model-name",default="",help="model name for the Chat Completions endpoint")
    track=commands.add_parser("track",help="run a real local camera worker")
    track.add_argument("--camera",type=int,default=0)
    track.add_argument("--backend",choices=("dshow","msmf","auto"),default="dshow")
    track.add_argument("--model",type=Path,default=ROOT/"models"/"hand_landmarker.task")
    track.add_argument("--port",type=int,default=DEFAULT_PORT)
    track.add_argument("--mirror",action="store_true")
    analyze=commands.add_parser("analyze",help="write evidence graph without running the server")
    analyze.add_argument("source")
    analyze.add_argument("--out",type=Path,default=ROOT/".runtime"/"graph.json")
    return parser


def main():
    parser=build_parser()
    args=parser.parse_args()
    try:
        if args.command=="analyze":
            from repo_triage_agent.analyze import from_source
            graph=from_source(args.source)
            args.out.parent.mkdir(parents=True,exist_ok=True)
            atomic_json(args.out,graph)
            print(f"Wrote {len(graph['nodes'])} nodes and {len(graph['findings'])} findings to {args.out}")
        elif args.command=="track":
            from laptop_hand_tracking.camera import run
            url=f"http://127.0.0.1:{args.port}"
            with urlopen(url+"/api/session",timeout=3) as response:
                session=json.load(response)
            if session["demo"]:
                raise ValueError("restart the service without --demo before running a camera")
            run(args.model,args.camera,url,session["token"],args.backend,args.mirror)
        else:
            from laptop_hand_tracking.simulator import run
            state=State(args.runtime,args.demo,args.model,args.model_endpoint,args.model_name)
            server=Server(args.port,state)
            if args.demo:
                threading.Thread(target=run,args=(state,state.stop),daemon=True).start()
            source=args.repo or (str(ROOT/"tests"/"fixtures"/"messy_repo") if args.demo else None)
            if source:
                state.start_analysis(source)
            print(f"SynapseDesk: http://127.0.0.1:{server.server_port} | {'SIMULATED HAND' if args.demo else 'waiting for camera'}",flush=True)
            try:
                server.serve_forever(poll_interval=.2)
            finally:
                state.stop.set()
                server.server_close()
    except KeyboardInterrupt:
        print("SynapseDesk stopped.")
    except (OSError,ValueError,RuntimeError) as exc:
        parser.exit(1,f"SynapseDesk: {exc}\n")


if __name__=="__main__":
    main()
