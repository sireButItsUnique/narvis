"""Tree-sitter plugins for TypeScript/JavaScript and C/C++.

Generic named-child walking (no per-grammar field assumptions):
names = first identifier/type_identifier child; calls = call_expression
function text; imports = import_statement text or preproc_include path.
Missing grammar packages fall back to heuristic (universal.py), never silent.
"""
import re

try:
    import tree_sitter
    _TS = True
except Exception:
    tree_sitter = None
    _TS = False

_GRAMMARS = {}
if _TS:
    try:
        import tree_sitter_javascript as _js
        _GRAMMARS[".js"] = _js.language()
        _GRAMMARS[".jsx"] = _js.language()
    except Exception:
        pass
    try:
        import tree_sitter_typescript as _ts
        _GRAMMARS[".ts"] = _ts.language_typescript()
        _GRAMMARS[".tsx"] = _ts.language_tsx()
    except Exception:
        pass
    try:
        import tree_sitter_c as _c
        _GRAMMARS[".c"] = _c.language()
        _GRAMMARS[".h"] = _c.language()
    except Exception:
        pass
    try:
        import tree_sitter_cpp as _cpp
        _GRAMMARS[".hpp"] = _cpp.language()
        _GRAMMARS[".cpp"] = _cpp.language()
    except Exception:
        pass
    try:
        import tree_sitter_java as _java
        _GRAMMARS[".java"] = _java.language()
    except Exception:
        pass
    try:
        import tree_sitter_kotlin as _kotlin
        _GRAMMARS[".kt"] = _kotlin.language()
        _GRAMMARS[".kts"] = _kotlin.language()
    except Exception:
        pass
    try:
        import tree_sitter_go as _go
        _GRAMMARS[".go"] = _go.language()
    except Exception:
        pass

FUNC_TYPES = {"function_definition", "function_declaration", "method_definition",
              "method_declaration", "constructor_declaration",
              "arrow_function", "function_expression", "generator_function_declaration"}
CLASS_TYPES = {"class_declaration", "class_specifier", "struct_specifier",
               "enum_specifier", "union_specifier", "interface_declaration",
               "type_alias_declaration", "type_declaration"}
CALL_TYPES = {"call_expression", "method_invocation"}
IMPORT_TYPES = {"import_statement", "import_declaration", "import"}
STRING_RE = re.compile(r"['\"]([^'\"]+)['\"]")


def _text(src: bytes, node):
    try:
        return src[node.start_byte:node.end_byte].decode("utf-8", errors="replace")
    except (IndexError, ValueError):
        return ""


def _first_name(src: bytes, node):
    for child in node.named_children:
        if child.type in ("identifier", "type_identifier", "property_identifier",
                          "field_identifier", "destructor_name"):
            return _text(src, child)
    # C/C++ wrap names in declarators: function_declarator -> declarator -> identifier.
    for child in node.named_children:
        if child.type.endswith("declarator") or child.type in ("declarator", "init_declarator",
                "function_declarator", "array_declarator", "pointer_declarator",
                "parenthesized_declarator", "abstract_declarator"):
            found = _first_name(src, child)
            if found:
                return found
    return ""


class TreePluginFacts:
    """Defs (name, generic, line, cfg) + imports + calls + docs. cfg always '' here."""

    def __init__(self, path, source, suffix):
        if not _TS or suffix not in _GRAMMARS:
            raise NotImplementedError(f"tree-sitter grammar for {suffix} not installed")
        self.path = path
        self.src = source.encode("utf-8", errors="replace")
        parser = tree_sitter.Parser(tree_sitter.Language(_GRAMMARS[suffix]))
        self.tree = parser.parse(self.src)
        self.defs, self.imports, self.calls, self.docs = [], [], [], []
        self.routes = []
        self._walk(self.tree.root_node, scope=[])

    def _line(self, node):
        return node.start_point.row + 1

    def _walk(self, node, scope):
        ntype = node.type
        if ntype == "comment":
            text = _text(self.src, node)
            if text.startswith("///") or text.startswith("/**"):
                self.docs.append((self._line(node), text.strip("/ *")[:2000].strip()))
            return
        if ntype in FUNC_TYPES:
            name = _first_name(self.src, node) or "anonymous"
            full = ".".join(scope + [name]) if scope else name
            self.defs.append((full, "Function", self._line(node), ""))
            self._calls_in(node, full)
            # Don't generic-recurse: _calls_in already walked the body.
            return
        if ntype in CLASS_TYPES:
            name = _first_name(self.src, node)
            if not name and ntype == "type_declaration":
                # Go: type Greeter struct {...} nests the name in a type_spec.
                for child in node.named_children:
                    if child.type == "type_spec":
                        name = _first_name(self.src, child)
                        break
            if name:
                generic = "Function" if ntype == "type_alias_declaration" else "Class"
                self.defs.append((name, generic, self._line(node), ""))
                scope = scope + [name]
            for child in node.named_children:
                self._walk(child, scope)
            return
        if ntype in IMPORT_TYPES:
            text = _text(self.src, node)
            quoted = STRING_RE.findall(text)
            if quoted:
                # Go multi-imports: one edge per path.
                for target in quoted:
                    self.imports.append((target, "", target.split("/")[-1], self._line(node), 0))
            else:
                path = re.sub(r"^\s*import\s+", "", text).strip().rstrip(";").strip()
                path = re.sub(r"^static\s+", "", path).strip()
                if path and " " not in path:
                    if "." in path:
                        mod, _, sym = path.rpartition(".")
                    else:
                        mod, sym = path, ""
                    self.imports.append((mod, sym, sym.split("/")[-1], self._line(node), 0))
            return
        if ntype == "preproc_include":
            text = _text(self.src, node)
            m = STRING_RE.search(text) or re.search(r"<([^>]+)>", text)
            target = m.group(1) if m else text[:200]
            self.imports.append((target, "", target.split("/")[-1], self._line(node), 0))
            return
        for child in node.named_children:
            self._walk(child, scope)

    def _calls_in(self, func_node, scope_name):
        stack = [func_node]
        while stack:
            node = stack.pop()
            if node.type in CALL_TYPES:
                text = ""
                if node.type == "method_invocation":
                    # Java: Helper.greet() is bare identifiers; the dotted path
                    # is the honest callee name.
                    text = _text(self.src, node).split("(")[0].strip()[:200]
                else:
                    fn = node.child_by_field_name("function")
                    text = _text(self.src, fn) if fn is not None else ""
                if not text:
                    for child in node.named_children:
                        if child.type in ("identifier", "property_identifier"):
                            text = _text(self.src, child)
                            break
                        if child.type in ("member_expression", "scoped_identifier",
                                          "field_expression", "call_expression",
                                          "navigation_expression", "selector_expression",
                                          "field_access"):
                            text = _text(self.src, child).split("(")[0][:200]
                            break
                if not text and node.type == "method_invocation":
                    # Java: Helper.greet() is bare identifiers, no function field.
                    text = _text(self.src, node).split("(")[0][:200]
                if text:
                    self.calls.append((scope_name, text[:200], self._line(node)))
                    # Fall through: nested calls live in the argument list.
            stack.extend(node.named_children)
