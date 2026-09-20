"""Generic repository adapters. Tiers for every repo, every language.

Tier-1 (full symbols+calls): python, rust, ts/js, c/c++ (tree-sitter where
installed, graceful fallback otherwise).
Tier-2 (heuristic): any other text file gets line-pattern defs + imports,
marked parser=heuristic. Tier-3: unknown/binary stays inventoried.
"""
from pathlib import Path


class RepoAdapter:
    name = "base"
    languages = ()
    tier = "full"
    def discover(self, root: Path):
        """Return project/package structure, e.g. Cargo workspace or py packages."""
        return {"project": root.name, "packages": []}
    def inventory(self, rel: str, suffix: str):
        """True if this adapter owns the file."""
        return False
    def parseFile(self, rel: str, text: str):
        """Return facts object or raise SyntaxError-like on parse failure."""
        raise NotImplementedError
    def checks(self):
        """Per-repo check commands, e.g. ['cargo test'] or ['python -m unittest']."""
        return []


class PythonAdapter(RepoAdapter):
    name = "python-ast-v1"
    languages = (".py",)
    def inventory(self, rel, suffix):
        return suffix == ".py"
    def parseFile(self, rel, text):
        # Import here to avoid circulars; PythonFacts stays in analyze.py for now.
        from .analyze import PythonFacts
        return PythonFacts(rel, text)
    def checks(self):
        return ["python -m unittest discover -s tests -v"]


class RustAdapter(RepoAdapter):
    """Tree-sitter + Cargo. Falls back to inventory when deps missing."""
    name = "rust-treesitter"
    languages = (".rs",)
    def inventory(self, rel, suffix):
        return suffix == ".rs"
    def parseFile(self, rel, text):
        from .rust import RustFacts
        return RustFacts(rel, text)
    def discover(self, root: Path):
        from .rust import discover
        return discover(root)
    def checks(self):
        return ["cargo test"]


class TypeScriptAdapter(RepoAdapter):
    """TS/JS via tree-sitter; heuristic fallback when grammars are missing."""
    name = "ts-treesitter"
    languages = (".js", ".jsx", ".ts", ".tsx")
    def inventory(self, rel, suffix):
        return suffix in self.languages
    def parseFile(self, rel, text):
        from .tsplugins import TreePluginFacts
        try:
            return TreePluginFacts(rel, text, Path(rel).suffix.lower())
        except NotImplementedError:
            from .universal import HeuristicFacts
            return HeuristicFacts(rel, text)
    def discover(self, root: Path):
        from .universal import read_npm_manifests
        pkgs = read_npm_manifests(root)
        return {"project": root.name, "packages": pkgs, "npm_workspace": bool(pkgs)}
    def checks(self):
        return ["npm test"]


class CFamilyAdapter(RepoAdapter):
    """C/C++ via tree-sitter; heuristic fallback when grammars are missing."""
    name = "c-treesitter"
    languages = (".c", ".h", ".hpp", ".cpp")
    def inventory(self, rel, suffix):
        return suffix in self.languages
    def parseFile(self, rel, text):
        from .tsplugins import TreePluginFacts
        try:
            return TreePluginFacts(rel, text, Path(rel).suffix.lower())
        except NotImplementedError:
            from .universal import HeuristicFacts
            return HeuristicFacts(rel, text)
    def checks(self):
        return ["cmake --build build", "ctest"]


class JavaAdapter(RepoAdapter):
    """Java via tree-sitter; heuristic fallback when the grammar is missing."""
    name = "java-treesitter"
    languages = (".java",)
    def inventory(self, rel, suffix):
        return suffix in self.languages
    def parseFile(self, rel, text):
        from .tsplugins import TreePluginFacts
        try:
            return TreePluginFacts(rel, text, Path(rel).suffix.lower())
        except NotImplementedError:
            from .universal import HeuristicFacts
            return HeuristicFacts(rel, text)
    def checks(self):
        return ["./gradlew test", "mvn test"]


class KotlinAdapter(RepoAdapter):
    """Kotlin via tree-sitter; heuristic fallback when the grammar is missing."""
    name = "kotlin-treesitter"
    languages = (".kt", ".kts")
    def inventory(self, rel, suffix):
        return suffix in self.languages
    def parseFile(self, rel, text):
        from .tsplugins import TreePluginFacts
        try:
            return TreePluginFacts(rel, text, Path(rel).suffix.lower())
        except NotImplementedError:
            from .universal import HeuristicFacts
            return HeuristicFacts(rel, text)
    def checks(self):
        return ["./gradlew test"]


class GoAdapter(RepoAdapter):
    """Go via tree-sitter; heuristic fallback when the grammar is missing."""
    name = "go-treesitter"
    languages = (".go",)
    def inventory(self, rel, suffix):
        return suffix in self.languages
    def parseFile(self, rel, text):
        from .tsplugins import TreePluginFacts
        try:
            return TreePluginFacts(rel, text, Path(rel).suffix.lower())
        except NotImplementedError:
            from .universal import HeuristicFacts
            return HeuristicFacts(rel, text)
    def discover(self, root: Path):
        from .universal import read_go_manifests
        pkgs = read_go_manifests(root)
        return {"project": root.name, "packages": pkgs, "go_workspace": bool(pkgs)}
    def checks(self):
        return ["go test ./..."]


class HeuristicAdapter(RepoAdapter):
    """Tier-2 catch-all: line-pattern defs + imports for any other text file."""
    name = "heuristic-v1"
    tier = "heuristic"
    languages = ()
    def inventory(self, rel, suffix):
        from .universal import tier_for
        return tier_for(suffix) == "heuristic"
    def parseFile(self, rel, text):
        from .universal import HeuristicFacts
        return HeuristicFacts(rel, text)
    def checks(self):
        return []


REGISTRY = [PythonAdapter(), RustAdapter(), TypeScriptAdapter(), CFamilyAdapter(),
            JavaAdapter(), KotlinAdapter(), GoAdapter(), HeuristicAdapter()]

def adapter_for(suffix: str):
    for adapter in REGISTRY:
        if suffix in adapter.languages:
            return adapter
    for adapter in REGISTRY:
        if adapter.tier == "heuristic" and adapter.inventory("", suffix):
            return adapter
    return None
