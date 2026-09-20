"""Universal tiers: TS/JS + C/C++ full parse, heuristic fallback, streaming budgets."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import repo_triage_agent.analyze as analyze_mod
from repo_triage_agent.analyze import analyze
from repo_triage_agent.tsplugins import _GRAMMARS

FIXTURE = Path(__file__).parent / "fixtures" / "poly_repo"
HAS_TS = ".ts" in _GRAMMARS
HAS_C = ".c" in _GRAMMARS
HAS_JAVA = ".java" in _GRAMMARS
HAS_KOTLIN = ".kt" in _GRAMMARS
HAS_GO = ".go" in _GRAMMARS


@unittest.skipUnless(HAS_TS, "pip install .[ts] for TypeScript parsing")
class TypeScriptTests(unittest.TestCase):
    def test_ts_symbols_relative_imports_and_calls(self):
        graph = analyze(FIXTURE)
        labels = {n["label"]: n for n in graph["nodes"]}
        self.assertIn("start", labels)
        self.assertIn("Runner", labels)
        self.assertIn("helper", labels)
        ids = {n["id"]: n["label"] for n in graph["nodes"]}
        # ./lib resolves to a real file, never invented.
        self.assertTrue(any(ids.get(e["source"]) == "app.ts" and ids.get(e["target"]) == "lib.js"
                            for e in graph["edges"] if e["kind"] == "imports"))
        # helper() resolves; missing() stays an explicit external.
        self.assertTrue(any(ids.get(e["source"]) == "start" and ids.get(e["target"]) == "helper"
                            for e in graph["edges"] if e["kind"] == "calls"))
        missing = [n for n in graph["nodes"] if n["label"] == "missing"]
        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]["evidence"].get("parser"), "unresolved_reference")

    def test_npm_manifest(self):
        graph = analyze(FIXTURE)
        self.assertIn("poly-app", graph["meta"].get("npm_packages", []))


@unittest.skipUnless(HAS_C, "pip install .[cfamily] for C parsing")
class CFamilyTests(unittest.TestCase):
    def test_c_symbols_includes_and_calls(self):
        graph = analyze(FIXTURE)
        labels = {n["label"]: n for n in graph["nodes"]}
        self.assertIn("total", labels)
        self.assertIn("main", labels)
        ids = {n["id"]: n["label"] for n in graph["nodes"]}
        # Quoted sibling header resolves to the real file.
        self.assertTrue(any(ids.get(e["source"]) == "main.c" and ids.get(e["target"]) == "util.h"
                            for e in graph["edges"] if e["kind"] == "imports"))
        # main -> total resolves; add() stays an explicit external.
        self.assertTrue(any(ids.get(e["source"]) == "main" and ids.get(e["target"]) == "total"
                            for e in graph["edges"] if e["kind"] == "calls"))
        self.assertTrue(any(n["label"] == "add" and n["kind"] == "external" for n in graph["nodes"]))


class HeuristicTests(unittest.TestCase):
    def test_heuristic_defs_without_invented_calls(self):
        # deploy.rb has no Tier-1 plugin in any environment: stable anchor.
        graph = analyze(FIXTURE)
        labels = {n["label"]: n for n in graph["nodes"]}
        self.assertIn("Deployer", labels)
        self.assertIn("run", labels)
        self.assertEqual(labels["Deployer"]["evidence"].get("parser"), "heuristic")
        self.assertFalse(labels["Deployer"]["evidence"].get("verified", True))
        callers = {n["label"] for n in graph["nodes"]
                   for e in graph["edges"] if e["kind"] == "calls" and e["source"] == n["id"]}
        self.assertNotIn("run", callers)


class BudgetTests(unittest.TestCase):
    def test_monorepo_streams_partial_graph(self):
        with tempfile.TemporaryDirectory() as temp:
            for i in range(810):
                Path(temp, f"m{i:04d}.go").write_text(f"package m{i}\nfunc F{i}() {{}}\n")
            graph = analyze(temp)  # must not raise
        self.assertTrue(graph["meta"]["truncated"])
        self.assertTrue(any(f["kind"] == "scan_truncated" for f in graph["findings"]))
        self.assertGreater(len(graph["nodes"]), 0)

    def test_node_budget_streams(self):
        old = analyze_mod.MAX_NODES
        analyze_mod.MAX_NODES = 5
        try:
            graph = analyze(FIXTURE)  # must not raise
        finally:
            analyze_mod.MAX_NODES = old
        self.assertTrue(graph["meta"]["truncated"])


@unittest.skipUnless(HAS_JAVA, "pip install .[jvm] for Java parsing")
class JavaTests(unittest.TestCase):
    def test_java_symbols_imports_and_calls(self):
        graph = analyze(FIXTURE)
        labels = {n["label"]: n for n in graph["nodes"]}
        self.assertIn("Main", labels)
        self.assertIn("Helper", labels)
        self.assertIn("Helper.greet", labels)
        ids = {n["id"]: n["label"] for n in graph["nodes"]}
        # Helper.greet() resolves to the sibling file's method (same package dir).
        self.assertTrue(any(ids.get(e["source"]) == "Main.main" and ids.get(e["target"]) == "Helper.greet"
                            for e in graph["edges"] if e["kind"] == "calls"))
        # missing() stays an explicit external.
        missing = [n for n in graph["nodes"] if n["label"] == "missing"]
        self.assertTrue(any(n["kind"] == "external" for n in missing))


@unittest.skipUnless(HAS_KOTLIN, "pip install .[jvm] for Kotlin parsing")
class KotlinTests(unittest.TestCase):
    def test_kotlin_symbols_and_calls(self):
        graph = analyze(FIXTURE)
        labels = {n["label"]: n for n in graph["nodes"]}
        self.assertIn("Server", labels)
        self.assertIn("Server.run", labels)
        ids = {n["id"]: n["label"] for n in graph["nodes"]}
        # run() -> main() resolves within the file.
        self.assertTrue(any(ids.get(e["source"]) == "Server.run" and ids.get(e["target"]) == "main"
                            for e in graph["edges"] if e["kind"] == "calls"))


@unittest.skipUnless(HAS_GO, "pip install .[go] for Go parsing")
class GoTests(unittest.TestCase):
    def test_go_symbols_manifest_and_calls(self):
        graph = analyze(FIXTURE)
        labels = {n["label"]: n for n in graph["nodes"]}
        self.assertIn("Shout", labels)
        self.assertIn("Greeter", labels)
        self.assertEqual(labels["Shout"]["evidence"].get("parser"), "go-treesitter")
        ids = {n["id"]: n["label"] for n in graph["nodes"]}
        # util.Shout() resolves to the sibling file (same package dir).
        self.assertTrue(any(ids.get(e["source"]) == "main" and ids.get(e["target"]) == "Shout"
                            for e in graph["edges"] if e["kind"] == "calls"))
        # lone() stays an explicit external.
        self.assertTrue(any(n["label"] == "lone" and n["kind"] == "external" for n in graph["nodes"]))
        self.assertIn("example.com/poly", graph["meta"].get("go_modules", []))



class NativeParserTests(unittest.TestCase):
    """tree-sitter is C. A bad core/grammar pairing does not raise — it kills the process.

    tree-sitter 0.26.0 bus-errors while collecting node objects, which took the whole
    service down mid-analysis. The parse has to run in a child process to be observable
    at all, so this asserts on the child's exit status rather than catching an exception.
    """
    ROOT = Path(__file__).resolve().parent.parent

    def test_repository_javascript_parses_without_killing_the_process(self):
        if ".js" not in _GRAMMARS:
            self.skipTest("pip install .[ts] for the JavaScript grammar")
        target = self.ROOT/"web_ar_canvas"/"public"/"app.js"
        probe = ("from pathlib import Path;"
                 "from repo_triage_agent.tsplugins import TreePluginFacts;"
                 f"f=TreePluginFacts('app.js', Path(r'{target}').read_text(encoding='utf-8'), '.js');"
                 "print(len(f.defs))")
        result = subprocess.run([sys.executable, "-c", probe], cwd=str(self.ROOT),
                                capture_output=True, text=True, timeout=120)
        if result.returncode < 0 or result.returncode > 128:
            signal = -result.returncode if result.returncode < 0 else result.returncode - 128
            self.fail(f"parsing app.js killed the interpreter with signal {signal}; "
                      f"check the installed tree-sitter core version against pyproject.toml")
        self.assertEqual(result.returncode, 0, result.stderr[-400:])
        self.assertGreater(int(result.stdout.strip()), 0)


if __name__ == "__main__":
    unittest.main()
