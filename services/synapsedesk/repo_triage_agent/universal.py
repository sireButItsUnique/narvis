"""Universal tiers: every repo gets something useful.

Tier-1 (full): tree-sitter/AST plugins per language (python, rust, ts/js, c/c++).
Tier-2 (heuristic): line-pattern symbols + imports for any other text file.
  Marked parser=heuristic, verified=False. No calls invented.
Tier-3 (inventory): binary/unknown extensions stay as file modules only.

Manifests: Cargo (rust.py), package.json (npm), go.mod (go) feed
Project -> Package dependency edges without executing anything.
"""
import json
import re
from pathlib import Path

FULL_SUFFIXES = {".py", ".rs", ".js", ".jsx", ".ts", ".tsx", ".c", ".h", ".hpp", ".cpp",
                 ".java", ".kt", ".kts", ".go"}
# Text-ish suffixes worth heuristic symbols instead of bare inventory.
HEURISTIC_SUFFIXES = {".rb", ".php", ".cs", ".swift",
                      ".scala", ".sh", ".bash", ".zsh", ".lua", ".pl", ".pm", ".r",
                      ".jl", ".dart", ".elm", ".erl", ".ex", ".exs", ".hs", ".ml",
                      ".m", ".mm", ".vue", ".svelte", ".astro", ".json", ".yaml", ".yml", ".toml"}

DEF_RE = re.compile(r"^\s*(?:export\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+|override\s+)*"
                    r"(?:class|struct|enum|trait|interface|type|func|function|def|fn|sub|method)\s+"
                    r"([A-Za-z_][\w$]*(?:::\w+)?)")
ARROW_RE = re.compile(r"^\s*(?:export\s+|default\s+|const\s+|let\s+|var\s+)*"
                      r"(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|[\w$]+\s*=>)")
IMPORT_RE = re.compile(r"^\s*(?:import\s+(.+?)|from\s+(\S+)\s+import|use\s+([^;]+);?"
                       r"|require\(\s*['\"]([^'\"]+)['\"]\s*\)|#include\s+[<\"]([^>\"]+)[>\"]"
                       r"|#import\s+[<\"]([^>\"]+)[>\"])\s*;?\s*$")


def tier_for(suffix: str):
    if suffix in FULL_SUFFIXES:
        return "full"
    if suffix in HEURISTIC_SUFFIXES:
        return "heuristic"
    return "inventory"


class HeuristicFacts:
    """Conservative line patterns. Defs + imports only; calls never invented."""

    def __init__(self, path, source):
        self.defs, self.imports, self.calls, self.docs = [], [], [], []
        self.routes = []
        for i, line in enumerate(source.splitlines(), 1):
            if len(line) > 1000:
                continue
            m = DEF_RE.match(line)
            if m:
                kind = "class" if re.match(r"^\s*(?:export\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+)*(?:class|struct|enum|trait|interface|type)\b", line) else "function"
                self.defs.append((m.group(1), kind, i))
                continue
            m = ARROW_RE.match(line)
            if m:
                self.defs.append((m.group(1), "function", i))
                continue
            m = IMPORT_RE.match(line)
            if m:
                target = next((g for g in m.groups() if g), "").strip().strip("'\"")[:200]
                if target:
                    self.imports.append((target, "", target.split("/")[-1], i, 0))


def read_npm_manifests(root: Path):
    """Find package.json files (root + one level of packages/*). No execution."""
    out = []
    candidates = [root / "package.json"]
    for sub in ("packages", "apps", "libs", "crates"):
        d = root / sub
        if d.is_dir():
            candidates.extend(p for p in d.glob("*/package.json"))
    for manifest in candidates:
        try:
            data = json.loads(manifest.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        deps = list((data.get("dependencies") or {}).keys()) + list((data.get("devDependencies") or {}).keys())
        out.append({"name": str(data.get("name") or manifest.parent.name),
                    "path": manifest.parent.relative_to(root).as_posix(),
                    "dependencies": sorted(set(deps))})
    return out


def read_go_manifests(root: Path):
    out = []
    for manifest in [root / "go.mod", *sorted((root).glob("*/go.mod"))]:
        try:
            text = manifest.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        mod = re.search(r"^module\s+(\S+)", text, re.M)
        reqs = re.findall(r"^\s*(?:require\s+)?([\w./-]+)\s+v[\w.-]+", text, re.M)
        out.append({"name": (mod.group(1) if mod else manifest.parent.name),
                    "path": manifest.parent.relative_to(root).as_posix(),
                    "dependencies": sorted(set(reqs))})
    return [m for m in out if m["path"] != "" or (root / "go.mod").exists()]
