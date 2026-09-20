import unittest
from pathlib import Path

from repo_triage_agent.rust import discover, RUST_AVAILABLE
from repo_triage_agent.analyze import analyze

FIXTURE = Path(__file__).parent / "fixtures" / "rust_repo"


@unittest.skipUnless(RUST_AVAILABLE, "pip install .[rust] for tree-sitter parsing")
class RustTests(unittest.TestCase):
    def test_workspace_discovery(self):
        cargo = discover(FIXTURE)
        self.assertTrue(cargo["cargo_workspace"])
        self.assertEqual(sorted(p["name"] for p in cargo["packages"]), ["adapter", "wm"])
        wm = next(p for p in cargo["packages"] if p["name"] == "wm")
        self.assertIn("adapter", wm["dependencies"])

    def test_symbols_locations_cfg_and_calls(self):
        graph = analyze(FIXTURE)
        labels = {n["label"]: n for n in graph["nodes"]}
        for name in ("StateManager", "OsAdapter", "Workspace"):
            self.assertIn(name, labels, f"missing {name}")
            self.assertTrue(labels[name]["evidence"]["path"].endswith(".rs"))
            self.assertGreaterEqual(labels[name]["evidence"]["line"], 1)
        win = labels["win_only"]
        self.assertIn("cfg", win["evidence"])
        self.assertIn("windows", win["evidence"]["cfg"])
        ids = {n["id"]: n["label"] for n in graph["nodes"]}
        # mod edge: lib.rs -> manager.rs (real file, not invented).
        self.assertTrue(any(ids.get(e["source"], "").endswith("lib.rs") and
                            ids.get(e["target"], "").endswith("manager.rs")
                            for e in graph["edges"] if e["kind"] == "imports"))
        # Inter-crate dependency: wm -> adapter.
        self.assertTrue(any(ids.get(e["source"]) == "wm" and ids.get(e["target"]) == "adapter"
                            for e in graph["edges"] if e["kind"] == "imports"))
        # Real call edge: caller -> StateManager::new.
        self.assertTrue(any(ids.get(e["source"]) == "caller" and ids.get(e["target"]) == "StateManager::new"
                            for e in graph["edges"] if e["kind"] == "calls"))
        # self.helper resolves within the impl.
        self.assertTrue(any(ids.get(e["source"]) == "StateManager::get" and
                            ids.get(e["target"]) == "StateManager::helper"
                            for e in graph["edges"] if e["kind"] == "calls"))
        # Unresolved calls are explicit externals, not invented symbols.
        unresolved = [n for n in graph["nodes"] if n["label"] == "unresolved_fn"]
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]["kind"], "external")
        self.assertEqual(unresolved[0]["evidence"].get("parser"), "unresolved_reference")
        # Macros marked, never expanded into edges.
        kinds = {f["kind"] for f in graph["findings"]}
        self.assertIn("rust_macro", kinds)
        self.assertIn("rust_trait_impl", kinds)


if __name__ == "__main__":
    unittest.main()
