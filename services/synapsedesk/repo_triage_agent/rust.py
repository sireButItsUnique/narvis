"""Rust/Cargo parsing. Tree-sitter when installed, inventory-only otherwise.

Extracts: workspace crates (Cargo manifest), modules, structs, enums, traits,
impl blocks, functions, imports (use), statically resolvable calls.
Preserves source locations + #[cfg]. Unresolved calls and macro-generated
relationships are marked explicitly, never invented.
"""
import glob
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python <3.11 never expected; keep import safe.
    tomllib = None

try:
    import tree_sitter
    import tree_sitter_rust
    _LANG = tree_sitter.Language(tree_sitter_rust.language())
    _PARSER = tree_sitter.Parser(_LANG)
    RUST_AVAILABLE = True
except Exception:
    tree_sitter = None
    RUST_AVAILABLE = False
    _PARSER = None


def discover(root: Path):
    """Cargo workspace discovery. Pure stdlib (tomllib)."""
    root = Path(root)
    manifest = root / "Cargo.toml"
    info = {"project": root.name, "packages": [], "cargo_workspace": manifest.exists()}
    if tomllib is None or not manifest.exists():
        return info
    try:
        data = tomllib.loads(manifest.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return info
    members = (data.get("workspace") or {}).get("members") or []
    if not members and "package" in data:
        members = ["."]
    for pattern in members:
        for match in sorted(glob.glob(pattern, root_dir=str(root), recursive=True)):
            pkg_dir = root / match
            cargo = pkg_dir / "Cargo.toml"
            if not cargo.is_file():
                continue
            try:
                pkg = tomllib.loads(cargo.read_text(encoding="utf-8", errors="replace"))
            except (OSError, ValueError):
                continue
            name = (pkg.get("package") or {}).get("name", Path(match).name)
            deps = sorted((pkg.get("dependencies") or {}).keys())
            info["packages"].append({"name": name, "path": Path(match).as_posix(), "dependencies": deps})
    return info


def _text(src: bytes, node):
    try:
        return src[node.start_byte:node.end_byte].decode("utf-8", errors="replace")
    except (IndexError, ValueError):
        return ""


def _name_of(src: bytes, node):
    named = node.child_by_field_name("name")
    if named is not None:
        return _text(src, named)
    for child in node.named_children:
        if child.type in ("identifier", "type_identifier"):
            return _text(src, child)
    return ""


class RustFacts:
    def __init__(self, path, source):
        if not RUST_AVAILABLE:
            raise NotImplementedError("tree-sitter rust not installed; pip install .[rust]")
        self.path = path
        self.src = source.encode("utf-8", errors="replace")
        self.tree = _PARSER.parse(self.src)
        self.defs, self.imports, self.calls, self.docs, self.mods = [], [], [], [], []
        self.macros, self.impls = [], []
        self.routes = []
        self._walk(self.tree.root_node, scope=[], pending_cfg=None)

    def _line(self, node):
        return node.start_point.row + 1

    def _cfg(self, node):
        for child in node.named_children:
            if child.type == "attribute_item" and "cfg" in _text(self.src, child):
                return _text(self.src, child)[:200]
        return ""

    def _walk(self, node, scope, pending_cfg):
        ntype = node.type
        if ntype == "line_comment":
            text = _text(self.src, node)
            if text.startswith("///") or text.startswith("//!"):
                self.docs.append((self._line(node), text[3:].strip()[:2000]))
            return
        if ntype == "attribute_item":
            text = _text(self.src, node)
            if "cfg" in text:
                # Attached to the next sibling item by the parent loop; stash here.
                node._pending_cfg = text[:200]
            return
        if ntype == "mod_item":
            name = _name_of(self.src, node) or "unknown"
            self.defs.append((name, "Module", self._line(node), pending_cfg or self._cfg(node)))
            self.mods.append((name, self._line(node)))
            return
        if ntype in ("struct_item", "enum_item", "trait_item"):
            name = _name_of(self.src, node)
            if name:
                generic = {"struct_item": "Struct", "enum_item": "Enum", "trait_item": "Trait"}[ntype]
                self.defs.append((name, generic, self._line(node), pending_cfg or self._cfg(node)))
            # Walk trait bodies for method signatures.
            for child in node.named_children:
                if child.type in ("declaration_list", "body"):
                    for item in child.named_children:
                        if item.type == "function_item":
                            fname = _name_of(self.src, item)
                            if fname:
                                self.defs.append((name + "::" + fname, "Function", self._line(item),
                                                  pending_cfg or self._cfg(item)))
            return
        if ntype == "impl_item":
            children = [c for c in node.named_children if c.type == "type_identifier"]
            target = _text(self.src, children[-1]) if children else ""
            trait = _text(self.src, children[0]) if len(children) > 1 else ""
            body = next((c for c in node.named_children if c.type == "declaration_list"), None)
            methods = []
            if body is not None:
                for item in body.named_children:
                    if item.type == "function_item":
                        fname = _name_of(self.src, item)
                        if fname:
                            full = (target + "::" + fname) if target else fname
                            methods.append(full)
                            self.defs.append((full, "Function", self._line(item), pending_cfg or self._cfg(item)))
                            self._calls_in(item, full)
            self.impls.append({"target": target, "trait": trait, "methods": methods,
                               "line": self._line(node), "cfg": pending_cfg or self._cfg(node)})
            return
        if ntype == "function_item":
            name = _name_of(self.src, node)
            if name:
                full = ".".join(scope + [name]) if scope else name
                self.defs.append((full, "Function", self._line(node), pending_cfg or self._cfg(node)))
                self._calls_in(node, full)
            return
        if ntype == "use_declaration":
            text = _text(self.src, node).rstrip(";")
            path = text[4:].strip() if text.startswith("use ") else text
            # Split trailing symbol: a::b::C -> (a::b, C). Glob stays whole.
            if "::" in path and not path.endswith("*") and "{" not in path:
                mod, _, sym = path.rpartition("::")
            else:
                mod, sym = path, ""
            self.imports.append((mod, sym, sym, self._line(node), 0))
            return
        if ntype == "macro_invocation":
            self.macros.append((_text(self.src, node)[:120], self._line(node)))
            return
        # Generic recursion with cfg attachment via preceding attribute_item siblings.
        cfg = pending_cfg
        for child in node.named_children:
            if child.type == "attribute_item" and "cfg" in _text(self.src, child):
                cfg = _text(self.src, child)[:200]
                continue
            self._walk(child, scope, cfg)
            if child.type not in ("attribute_item",):
                cfg = pending_cfg

    def _calls_in(self, func_node, scope_name):
        stack = [func_node]
        while stack:
            node = stack.pop()
            if node.type == "call_expression":
                fn = node.child_by_field_name("function")
                if fn is not None:
                    text = _text(self.src, fn)
                    if text:
                        self.calls.append((scope_name, text, self._line(node)))
            elif node.type == "macro_invocation":
                self.macros.append((_text(self.src, node)[:120], self._line(node)))
                continue
            stack.extend(node.named_children)
