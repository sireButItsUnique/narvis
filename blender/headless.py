"""The server's own Blender: no window, no user, just the bridge. server/blender-process.js starts it as
    blender -b --factory-startup --python-exit-code 3 --python blender/headless.py -- <repo>/blender
with HOLO_BRIDGE_TOKEN (required, never on the command line), HOLO_BRIDGE_PORT (0 = any free port) and
HOLOMODEL_HOME in its environment. It prints one line 'HOLO_READY {json}' when it serves and 'HOLO_BYE' when it
stops, and it stops when its stdin closes: the server keeps that pipe open and never writes to it, so even a
force-killed server (Windows doesn't take children down with it) takes this Blender with it.
"""
import json
import os
import sys
import threading
import time

t0 = time.perf_counter()
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
sys.path.insert(0, argv[0] if argv else os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import holomodel_bridge as hb  # noqa: E402

QUIT_GRACE_S = 5   # a job still running this long after the server went away is stuck (e.g. while True): leave


def main():
    token = os.environ.get('HOLO_BRIDGE_TOKEN') or ''
    if len(token) < 16:
        print('HOLO_FATAL no HOLO_BRIDGE_TOKEN', flush=True)
        os._exit(2)
    stop = threading.Event()

    def watch_stdin():
        try:
            while sys.stdin.buffer.read(1):
                pass
        except (OSError, ValueError):
            pass
        stop.set()
        hb.wake()
        time.sleep(QUIT_GRACE_S)
        print('HOLO_BYE (a job was still running)', flush=True)
        os._exit(0)

    def quit_cmd(req):
        stop.set()
        hb.wake()
        return {'ok': True}

    hb.COMMANDS['quit'] = quit_cmd
    hb.webio.clear_scene()   # factory startup's Cube, camera and light: the Cube once cost Fable a whole turn
    port = hb.start_server(port=int(os.environ.get('HOLO_BRIDGE_PORT') or 0), token=token, advertise=False)
    threading.Thread(target=watch_stdin, daemon=True).start()
    print('HOLO_READY ' + json.dumps({'port': port, 'pid': os.getpid(), 'blender': bpy.app.version_string,
                                      'startup_s': round(time.perf_counter() - t0, 3)}), flush=True)
    hb.serve_headless(stop)
    hb.stop_server()
    print('HOLO_BYE', flush=True)
    # a daemon thread still blocked reading stdin crashes CPython's shutdown (_enter_buffered_busy ->
    # EXCEPTION_ACCESS_VIOLATION); everything worth keeping is already saved, so skip the interpreter teardown
    sys.stdout.flush()
    os._exit(0)


main()
