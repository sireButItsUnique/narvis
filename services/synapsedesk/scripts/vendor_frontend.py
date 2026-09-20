"""Vendor a local frontend/dist build into synapsedesk/vendored/react. Dev-only; users never run npm."""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "dist"
DEST = ROOT / "synapsedesk" / "vendored" / "react"

if not SRC.is_dir():
    raise SystemExit(f"nothing to vendor: {SRC} missing (run npm run build in frontend/ first)")
shutil.rmtree(DEST, ignore_errors=True)
shutil.copytree(SRC, DEST)
print(f"Vendored {SRC} -> {DEST}")
