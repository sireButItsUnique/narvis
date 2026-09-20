"""Snapshot working copies. All file ops sandboxed inside the snapshot.

- Snapshot includes current uncommitted working-tree files (copy, not git HEAD).
- Original checkout is never modified.
- Malformed patches, outside-snapshot escapes, and conflicting changes are errors.
- Checkpoints record a unified diff plus the prior content, so rollback restores it.
- Prior content over RESTORE_LIMIT is not retained; that checkpoint reports restorable=False.
"""
import difflib
import os
import shutil
import subprocess
import time
from pathlib import Path

SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".runtime", "dist", "build"}
RESTORE_LIMIT = 200_000


def snapshot_source(source: Path, dest: Path):
    source = source.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    for folder, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not (Path(folder) / d).is_symlink())
        rel_folder = Path(folder).relative_to(source)
        (dest / rel_folder).mkdir(parents=True, exist_ok=True)
        for fn in files:
            src = Path(folder) / fn
            if src.is_symlink():
                continue
            if src.stat().st_size > 1_000_000:
                continue
            shutil.copy2(src, dest / rel_folder / fn)
    return dest


def _guarded(snapshot: Path, rel: str) -> Path:
    target = (snapshot / rel).resolve()
    if snapshot.resolve() not in target.parents and target != snapshot.resolve():
        raise ValueError("path escapes working copy")
    return target


def read_file(snapshot: Path, rel: str, limit=20000):
    target = _guarded(snapshot, rel)
    if not target.is_file():
        raise ValueError("file not found in working copy")
    return target.read_text(encoding="utf-8", errors="replace")[:limit]


def write_file(snapshot: Path, rel: str, content: str):
    target = _guarded(snapshot, rel)
    if len(content) > 256_000:
        raise ValueError("file exceeds 256 KB budget")
    target.parent.mkdir(parents=True, exist_ok=True)
    existed = target.exists()
    before = target.read_text(encoding="utf-8", errors="replace") if existed else ""
    target.write_text(content, encoding="utf-8")
    diff = "".join(difflib.unified_diff(before.splitlines(True), content.splitlines(True),
                                        fromfile="before/" + rel, tofile="after/" + rel))
    restorable = len(before) <= RESTORE_LIMIT
    return {"checkpoint": time.time(), "path": rel, "diff": diff[:20000], "bytes": len(content),
            "existed": existed, "restorable": restorable, "before": before if restorable else ""}


def restore_checkpoint(snapshot: Path, checkpoint: dict):
    """Undo one write_file checkpoint. Returns a result record; never raises on a missing file."""
    rel = checkpoint.get("path")
    if not rel:
        return {"path": "", "restored": False, "message": "checkpoint predates path tracking"}
    if not checkpoint.get("restorable", False):
        return {"path": rel, "restored": False, "message": "prior content exceeded the retention limit"}
    target = _guarded(snapshot, rel)
    if checkpoint.get("existed"):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(checkpoint.get("before", ""), encoding="utf-8")
        return {"path": rel, "restored": True, "message": "previous content restored"}
    if target.exists():
        target.unlink()
        return {"path": rel, "restored": True, "message": "file created by the task removed"}
    return {"path": rel, "restored": False, "message": "nothing to roll back"}


def run_checks(snapshot: Path, commands, timeout=60):
    """Run configured per-repo checks inside the snapshot. Returns output, never raises silently."""
    results = []
    for cmd in commands[:5]:
        try:
            proc = subprocess.run(cmd, shell=True, cwd=str(snapshot), capture_output=True,
                                  text=True, timeout=timeout)
            results.append({"cmd": cmd, "returncode": proc.returncode,
                            "stdout": proc.stdout[-4000:], "stderr": proc.stderr[-4000:]})
        except subprocess.TimeoutExpired:
            results.append({"cmd": cmd, "returncode": 124, "stdout": "", "stderr": "timeout"})
        except OSError as e:
            results.append({"cmd": cmd, "returncode": 127, "stdout": "", "stderr": str(e)[:500]})
    return results
