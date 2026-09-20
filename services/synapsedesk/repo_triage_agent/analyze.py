"""Evidence-first repository triage. Never imports or executes inspected code."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlparse
from synapsedesk.contracts import validate_graph, MAX_NODES, MAX_EDGES
from .adapters import adapter_for, REGISTRY

SKIP = {".git", ".venv", "venv", "node_modules", "build", "dist", "__pycache__", ".runtime", ".next", "vendor"}
from .universal import FULL_SUFFIXES, HEURISTIC_SUFFIXES
SOURCE = FULL_SUFFIXES | HEURISTIC_SUFFIXES | {".html", ".css", ".json", ".yaml", ".yml", ".toml", ".xml"}
ROUTE = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(/[\w/{}:.-]*)", re.I)


def ident(value):
    return hashlib.sha256(value.encode()).hexdigest()[:20]


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return f"{base}.{node.attr}" if base else ""
    return ""


class PythonFacts(ast.NodeVisitor):
    def __init__(self, path, source):
        self.path, self.source = path, source
        self.scope = []
        self.defs, self.imports, self.calls, self.routes, self.docs = [], [], [], [], []
        self.visit(ast.parse(source, filename=path))

    def definition(self, node, kind):
        name = ".".join(self.scope+[node.name])
        self.defs.append((name, kind, node.lineno))
        doc = ast.get_docstring(node)
        if doc:
            self.docs.append((node.body[0].lineno, doc))
        if kind == "function":
            for dec in node.decorator_list:
                if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.args:
                    route = dec.args[0]
                    if isinstance(route, ast.Constant) and isinstance(route.value, str) and route.value.startswith("/"):
                        method = dec.func.attr.lower()
                        methods = [method.upper()] if method in ("get", "post", "put", "patch", "delete", "head", "options") else []
                        if method == "route":
                            methods = ["GET"]
                            for kw in dec.keywords:
                                if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple)):
                                    methods = [x.value.upper() for x in kw.value.elts if isinstance(x, ast.Constant) and isinstance(x.value, str)]
                        self.routes.extend((m, route.value, node.lineno) for m in methods)
        # Decorators/defaults execute in enclosing scope; body belongs to the new scope.
        for dec in node.decorator_list:
            self.visit(dec)
        self.scope.append(node.name)
        for child in node.body:
            self.visit(child)
        self.scope.pop()

    def visit_FunctionDef(self, node): self.definition(node, "function")
    def visit_AsyncFunctionDef(self, node): self.definition(node, "function")
    def visit_ClassDef(self, node): self.definition(node, "class")

    def visit_Module(self, node):
        doc = ast.get_docstring(node)
        if doc:
            self.docs.append((1, doc))
        self.generic_visit(node)

    def visit_Import(self, node):
        for a in node.names:
            self.imports.append((a.name, "", a.asname or a.name.split('.')[0], node.lineno, 0))

    def visit_ImportFrom(self, node):
        for a in node.names:
            self.imports.append((node.module or "", a.name, a.asname or a.name, node.lineno, node.level))

    def visit_Call(self, node):
        name = dotted(node.func)
        if name:
            self.calls.append((".".join(self.scope), name, node.lineno))
        self.generic_visit(node)


def cycles(edges):
    """Tarjan SCC; callers pass only module import edges."""
    adjacent = {}
    for edge in edges:
        adjacent.setdefault(edge["source"], set()).add(edge["target"])
    indices, low, stack, active, result = {}, {}, [], set(), []
    def visit(v):
        indices[v] = low[v] = len(indices)
        stack.append(v)
        active.add(v)
        for w in sorted(adjacent.get(v, ())):
            if w not in indices:
                visit(w)
                low[v] = min(low[v], low[w])
            elif w in active:
                low[v] = min(low[v], indices[w])
        if low[v] == indices[v]:
            group = []
            while True:
                w = stack.pop()
                active.remove(w)
                group.append(w)
                if w == v: break
            if len(group) > 1 or v in adjacent.get(v, ()):
                result.append(sorted(group))
    for v in sorted(adjacent):
        if v not in indices: visit(v)
    return result


def analyze(path):
    root = Path(path).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("repository must be a directory")
    nodes, edges, findings, facts, documents, routes = [], [], [], {}, [], []
    plugin_facts = {}
    rust_facts = {}
    module_ids, module_names, definitions = {}, {}, {}
    count, total_bytes, skipped_files = 0, 0, 0
    truncated = False

    def note_truncated(message, evidence_path=""):
        nonlocal truncated
        if not truncated:
            truncated = True
            findings.append(dict(kind="scan_truncated", severity="warning", message=message,
                                 evidence=[dict(path=evidence_path, line=1)]))
    for folder, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not (Path(folder)/d).is_symlink())
        for filename in sorted(files):
            source_path = Path(folder)/filename
            if source_path.is_symlink() or source_path.suffix.lower() not in SOURCE | {".md"}:
                continue
            count += 1
            size = source_path.stat().st_size
            total_bytes += size
            rel = source_path.relative_to(root).as_posix()
            if count > 800 or total_bytes > 20_000_000:
                # Monorepos stream: publish a partial graph with an explicit
                # finding instead of rejecting the whole repository.
                skipped_files += 1
                note_truncated(f"Scan budget reached at {count} files / {total_bytes // 1000000} MB; "
                               "publishing a partial graph (refine scope or shard by subdirectory).", rel)
                continue
            if size > 256_000:
                findings.append(dict(kind="scan_skipped", severity="info", message="File exceeds 256 KB scan limit", evidence=[dict(path=rel, line=1)]))
                continue
            text = source_path.read_text(encoding="utf-8", errors="replace")
            if source_path.suffix.lower() == ".md":
                documents.append((rel, 1, text))
                continue
            mid = "m:"+ident(rel)
            if len(nodes) >= MAX_NODES:
                skipped_files += 1
                note_truncated("Node budget reached; publishing a partial graph.", rel)
                continue
            module_ids[rel] = mid
            name = rel.rsplit('.', 1)[0].replace('/', '.')
            if name.endswith(".__init__"): name = name[:-9]
            module_names[name] = rel
            nodes.append(dict(id=mid, label=rel, kind="module", evidence=dict(path=rel,line=1,parser="file"),
                                generic_kind="Module", language=source_path.suffix.lower().lstrip('.') or "unknown",
                                scope=dict(project=root.name, package="", module=name)))
            adapter = adapter_for(source_path.suffix.lower())
            if adapter is not None and adapter.name.startswith("python"):
                try:
                    f = adapter.parseFile(rel, text)
                    facts[rel] = f
                except (SyntaxError, RecursionError) as exc:
                    findings.append(dict(kind="parse_error", severity="warning", message=str(exc)[:300], evidence=[dict(path=rel,line=getattr(exc,"lineno",1) or 1)]))
                    continue
                for name, kind, line in f.defs:
                    if len(nodes) >= MAX_NODES:
                        note_truncated("Node budget reached; publishing a partial graph.", rel)
                        break
                    nid = "s:"+ident(rel+":"+name+":"+str(line))
                    definitions[(rel,name)] = nid
                    nodes.append(dict(id=nid,label=name,kind=kind,evidence=dict(path=rel,line=line,parser="python_ast"),
                                        generic_kind="Symbol", language="py",
                                        scope=dict(project=root.name, package="", module=rel, symbol=name)))
                    edges.append(dict(id="e:"+ident(mid+nid),source=mid,target=nid,kind="contains"))
                documents.extend((rel,line,doc) for line,doc in f.docs)
                routes.extend((method,route,rel,line) for method,route,line in f.routes)
            elif adapter is not None and adapter.name in ("rust-treesitter", "ts-treesitter", "c-treesitter",
                                                              "java-treesitter", "kotlin-treesitter", "go-treesitter",
                                                              "heuristic-v1"):
                parser_names = {"rust-treesitter": "rust-treesitter", "ts-treesitter": "ts-treesitter",
                                "c-treesitter": "c-treesitter", "java-treesitter": "java-treesitter",
                                "kotlin-treesitter": "kotlin-treesitter", "go-treesitter": "go-treesitter",
                                "heuristic-v1": "heuristic"}
                try:
                    pf = adapter.parseFile(rel, text)
                except NotImplementedError:
                    findings.append(dict(kind="coverage",severity="info",
                        message="No parser available for this file; inventoried only",
                        evidence=[dict(path=rel,line=1)]))
                    continue
                except (ValueError, RecursionError) as exc:
                    findings.append(dict(kind="parse_error", severity="warning", message=str(exc)[:300], evidence=[dict(path=rel,line=1)]))
                    continue
                pname = "heuristic" if type(pf).__name__ == "HeuristicFacts" else parser_names[adapter.name]
                lang = source_path.suffix.lower().lstrip(".") or "unknown"
                plugin_facts[rel] = (pf, pname, lang)
                if adapter.name == "rust-treesitter":
                    rust_facts[rel] = pf
                for d in pf.defs:
                    dname, generic, line = d[0], d[1], d[2]
                    cfg = d[3] if len(d) > 3 else ""
                    if generic == "Module":
                        continue  # resolved to files below; no invented nodes.
                    if len(nodes) >= MAX_NODES:
                        note_truncated("Node budget reached; publishing a partial graph.", rel)
                        break
                    # Heuristic defs arrive as (name, kind, line): kind is already a node kind.
                    kind = generic if generic in ("function", "class", "module", "external") else \
                        ("function" if generic == "Function" else "class")
                    out_generic = generic if generic not in ("function", "class") else \
                        ("Symbol-" + generic)
                    nid = "s:"+ident(rel+":"+dname+":"+str(line))
                    definitions[(rel,dname)] = nid
                    ev = dict(path=rel,line=line,parser=pname)
                    if cfg:
                        ev["cfg"] = cfg
                    if pname == "heuristic":
                        ev["verified"] = False
                    nodes.append(dict(id=nid,label=dname,kind=kind,evidence=ev,
                                        generic_kind=out_generic, language=lang,
                                        scope=dict(project=root.name, package="", module=rel, symbol=dname)))
                    edges.append(dict(id="e:"+ident(mid+nid),source=mid,target=nid,kind="contains"))
                documents.extend((rel,line,doc) for line,doc in getattr(pf, "docs", []))
                for macro_text, mline in getattr(pf, "macros", []):
                    findings.append(dict(kind="rust_macro" if adapter.name == "rust-treesitter" else "macro_unexpanded",
                        severity="info",
                        message=f"Macro-generated code is not expanded; no edges invented: {macro_text[:100]}",
                        evidence=[dict(path=rel,line=mline)]))
                for impl in getattr(pf, "impls", []):
                    if impl.get("trait"):
                        findings.append(dict(kind="rust_trait_impl",severity="info",
                            message=f"impl {impl['trait']} for {impl['target'] or '?'} ({len(impl['methods'])} methods)",
                            evidence=[dict(path=rel,line=impl["line"])]))
                continue
            else:
                findings.append(dict(kind="coverage",severity="info",
                    message="Module inventoried without symbol extraction",
                    evidence=[dict(path=rel,line=1)]))

    def edge(a,b,kind,line=1,path=""):
        if a is None or b is None:
            return
        key = "e:"+ident(a+b+kind)
        if key not in edge_ids:
            if len(edges) >= MAX_EDGES:
                note_truncated("Edge budget reached; publishing a partial graph.", path)
                return
            edge_ids.add(key)
            edges.append(dict(id=key,source=a,target=b,kind=kind,evidence=dict(path=path,line=line)))

    edge_ids = {e["id"] for e in edges}
    external = {}
    def external_node(name):
        if name not in external:
            if len(nodes) >= MAX_NODES:
                note_truncated("Node budget reached; publishing a partial graph.")
                return None
            nid = "x:"+ident(name)
            external[name] = nid
            nodes.append(dict(id=nid,label=name[:240],kind="external",evidence=dict(path="",parser="unresolved_reference")))
        return external[name]

    for rel,f in facts.items():
        aliases = {}
        parent = rel.rsplit('/',1)[0].replace('/','.') if '/' in rel else ""
        for module,symbol,alias,line,level in f.imports:
            if level:
                parts = parent.split('.') if parent else []
                base = parts[:len(parts)-level+1] if level <= len(parts)+1 else []
                module = '.'.join(base+([module] if module else []))
            full = '.'.join(x for x in (module,symbol) if x)
            imported_path = module_names.get(full) or module_names.get(module)
            target = module_ids[imported_path] if imported_path else external_node(full)
            edge(module_ids[rel],target,"imports",line,rel)
            aliases[alias] = (imported_path, symbol if full not in module_names else "")
        for scope,name,line in f.calls:
            caller = definitions.get((rel,scope), module_ids[rel])
            target = None
            prefix = scope.split('.')[:-1]
            while True:
                target = definitions.get((rel,'.'.join(prefix+[name])))
                if target or not prefix: break
                prefix.pop()
            first,_,tail = name.partition('.')
            if target is None and first in aliases:
                imported_path,symbol = aliases[first]
                target = definitions.get((imported_path,'.'.join(x for x in (symbol,tail) if x)))
            if target is None:
                target = external_node(name)
            edge(caller,target,"calls",line,rel)

    for rel, rf in rust_facts.items():
        # mod declarations -> real file edges when the target exists; never invented.
        parent_dir = rel.rpartition("/")[0]
        for mod_name, mline in rf.mods:
            for candidate in (f"{parent_dir}/{mod_name}.rs" if parent_dir else f"{mod_name}.rs",
                              f"{parent_dir}/{mod_name}/mod.rs" if parent_dir else f"{mod_name}/mod.rs"):
                if candidate in module_ids:
                    edge(module_ids[rel], module_ids[candidate], "imports", mline, rel)
                    break
        for module, symbol, _alias, line, _level in rf.imports:
            # use paths stay ::-style; workspace-external crates are explicit externals.
            full = "::".join(x for x in (module, symbol) if x)
            target = external_node(full or module or "unknown")
            edge(module_ids[rel], target, "imports", line, rel)
        for scope, name, line in rf.calls:
            caller = definitions.get((rel, scope), module_ids[rel])
            # Same-file statics: exact, Type::method, or bare method of enclosing impl.
            target = definitions.get((rel, name))
            if target is None and (name.startswith("self.") or name.startswith("Self::")):
                # self.helper() inside impl StateManager -> StateManager::helper.
                owner = scope.split("::")[0] if "::" in scope else ""
                suffix = name.split(".", 1)[1] if name.startswith("self.") else name.split("::", 1)[1]
                if owner and suffix:
                    target = definitions.get((rel, owner + "::" + suffix))
            if target is None and "::" in name:
                base, _, method = name.rpartition("::")
                target = definitions.get((rel, name)) or definitions.get((rel, method))
                if target is None:
                    # Type::new-style constructors resolve to the type node.
                    for (r, dname), nid in definitions.items():
                        if r == rel and dname == base:
                            target = nid
                            break
            if target is None:
                target = external_node(name)  # explicitly unresolved; parser=unresolved_reference.
            edge(caller, target, "calls", line, rel)

    for rel, (pf, pname, lang) in plugin_facts.items():
        if rel in rust_facts:
            continue  # resolved in the Rust loop above.
        parent_dir = rel.rpartition("/")[0]
        for module, symbol, _alias, line, _level in getattr(pf, "imports", []):
            target = None
            if module.startswith("."):
                base = (parent_dir + "/" + module) if parent_dir else module
                # Normalize ./ and ../ lexically (no filesystem access beyond walk).
                parts = []
                for seg in base.split("/"):
                    if seg in ("", "."):
                        continue
                    if seg == "..":
                        parts = parts[:-1]
                    else:
                        parts.append(seg)
                norm = "/".join(parts)
                for cand in (norm, norm + ".ts", norm + ".tsx", norm + ".js", norm + ".jsx",
                             norm + ".c", norm + ".h", norm + ".cpp", norm + ".hpp",
                             norm + "/index.ts", norm + "/index.js"):
                    if cand in module_ids:
                        target = module_ids[cand]
                        break
            elif pname == "c-treesitter" and "/" not in module:
                # Quoted #includes resolve to sibling headers when present.
                for cand in ((parent_dir + "/" + module) if parent_dir else module, module):
                    if cand in module_ids:
                        target = module_ids[cand]
                        break
            if target is None:
                full = "/".join(x for x in (module, symbol) if x) or module or "unknown"
                target = external_node(full)
            edge(module_ids[rel], target, "imports", line, rel)
        for scope, name, line in getattr(pf, "calls", []):
            caller = definitions.get((rel, scope), module_ids[rel])
            target = definitions.get((rel, name))
            if target is None:
                # obj.method() where method is defined in this file.
                tail = name.split(".")[-1].split("::")[-1]
                for (r, dname), nid in definitions.items():
                    if r == rel and (dname == tail or dname.endswith("::" + tail)):
                        target = nid
                        break
            if target is None and pname in ("java-treesitter", "kotlin-treesitter", "go-treesitter"):
                # Same-directory (same package) statics: Helper.greet() finds
                # greet in a sibling file. Exact name match only, never guessed.
                tail = name.split(".")[-1].split("::")[-1]
                rel_dir = rel.rpartition("/")[0]
                for (r, dname), nid in definitions.items():
                    if r.rpartition("/")[0] != rel_dir:
                        continue
                    if dname == tail or dname.endswith("." + tail) or dname.endswith("::" + tail):
                        target = nid
                        break
            if target is None:
                target = external_node(name)  # explicitly unresolved.
            edge(caller, target, "calls", line, rel)

    # Cargo workspace: Project -> Package -> Module chain + inter-crate dependencies.
    try:
        from .rust import discover as cargo_discover
        cargo = cargo_discover(root)
    except Exception:
        cargo = {"project": root.name, "packages": [], "cargo_workspace": False}
    crate_nodes = {}
    if cargo.get("cargo_workspace") and cargo.get("packages") and len(nodes) < MAX_NODES:
        wid = "m:" + ident("cargo-workspace:" + root.name)
        nodes.append(dict(id=wid, label=cargo["project"], kind="module",
                          evidence=dict(path="Cargo.toml", line=1, parser="cargo-manifest"),
                          generic_kind="Project", language="rust",
                          scope=dict(project=root.name, package="", module="")))
        for pkg in cargo["packages"]:
            if len(nodes) >= MAX_NODES:
                note_truncated("Node budget reached; publishing a partial graph.", pkg.get("path", ""))
                break
            cid = "m:" + ident("cargo-crate:" + pkg["name"])
            crate_nodes[pkg["name"]] = cid
            nodes.append(dict(id=cid, label=pkg["name"], kind="module",
                              evidence=dict(path=(pkg["path"] + "/Cargo.toml"), line=1, parser="cargo-manifest"),
                              generic_kind="Package", language="rust",
                              scope=dict(project=root.name, package=pkg["name"], module="")))
            edge(wid, cid, "contains", 1, "Cargo.toml")
            for root_file in (pkg["path"] + "/src/lib.rs", pkg["path"] + "/src/main.rs"):
                key = root_file[2:] if root_file.startswith("./") else root_file
                if key in module_ids:
                    edge(cid, module_ids[key], "contains", 1, key)
                    break
        for pkg in cargo["packages"]:
            for dep in pkg.get("dependencies", []):
                if dep in crate_nodes:
                    edge(crate_nodes[pkg["name"]], crate_nodes[dep], "imports", 1, pkg["path"] + "/Cargo.toml")
                else:
                    edge(crate_nodes[pkg["name"]], external_node("crate::" + dep), "imports", 1, pkg["path"] + "/Cargo.toml")
    # npm + go manifests: same Project -> Package dependency shape, no execution.
    try:
        from .universal import read_npm_manifests, read_go_manifests
        npm_pkgs = read_npm_manifests(root)
        go_pkgs = read_go_manifests(root)
    except Exception:
        npm_pkgs, go_pkgs = [], []
    for kind, pkgs, parser in (("npm", npm_pkgs, "npm-manifest"), ("go", go_pkgs, "gomod-manifest")):
        if not pkgs or len(nodes) >= MAX_NODES:
            continue
        wid = "m:" + ident(kind + "-workspace:" + root.name)
        nodes.append(dict(id=wid, label=root.name, kind="module",
                          evidence=dict(path="package.json" if kind == "npm" else "go.mod", line=1, parser=parser),
                          generic_kind="Project", language="js" if kind == "npm" else "go",
                          scope=dict(project=root.name, package="", module="")))
        pkg_nodes = {}
        for pkg in pkgs:
            if len(nodes) >= MAX_NODES:
                note_truncated("Node budget reached; publishing a partial graph.", pkg.get("path", ""))
                break
            cid = "m:" + ident(kind + "-pkg:" + pkg["name"])
            pkg_nodes[pkg["name"]] = cid
            manifest = (pkg["path"] + "/" if pkg["path"] not in ("", ".") else "") + \
                       ("package.json" if kind == "npm" else "go.mod")
            nodes.append(dict(id=cid, label=pkg["name"], kind="module",
                              evidence=dict(path=manifest, line=1, parser=parser),
                              generic_kind="Package", language="js" if kind == "npm" else "go",
                              scope=dict(project=root.name, package=pkg["name"], module="")))
            edge(wid, cid, "contains", 1, manifest)
        for pkg in pkgs:
            if pkg["name"] not in pkg_nodes:
                continue
            for dep in pkg.get("dependencies", []):
                if dep in pkg_nodes:
                    edge(pkg_nodes[pkg["name"]], pkg_nodes[dep], "imports", 1, pkg["name"])
                else:
                    edge(pkg_nodes[pkg["name"]], external_node(dep), "imports", 1, pkg["name"])
    labels = {n["id"]:n["label"] for n in nodes}
    for group in cycles([e for e in edges if e["kind"] == "imports" and e["target"] in module_ids.values()]):
        findings.append(dict(kind="circular_dependency",severity="warning",message="Import cycle: "+" → ".join(labels[n] for n in group),nodes=group,evidence=[dict(path=labels[n],line=1) for n in group]))
    implemented = {(method,route) for method,route,_,_ in routes}
    documented = set()
    def normalize(route):
        return re.sub(r"\{[^}]+\}|:[A-Za-z_]\w*", "{param}", route).rstrip('/') or '/'
    normalized = {(method,normalize(route)) for method,route in implemented}
    for rel,line,text in documents:
        for match in ROUTE.finditer(text):
            method,route = match[1].upper(),match[2].rstrip('.')
            documented.add((method,normalize(route)))
            if (method,normalize(route)) not in normalized:
                findings.append(dict(kind="unmatched_documented_route",severity="warning",
                    message=f"{method} {route} is documented but no matching literal Python route was found; verify prefixes/dynamic registration before calling it dead",
                    evidence=[dict(path=rel,line=line+text[:match.start()].count('\n'))]))
    for method,route,rel,line in routes:
        if (method,normalize(route)) not in documented:
            findings.append(dict(kind="undocumented_route",severity="info",message=f"{method} {route} is implemented but absent from scanned API documentation",evidence=[dict(path=rel,line=line)]))
    if len(nodes)>MAX_NODES or len(edges)>MAX_EDGES:
        # Backstop: every creation path above is capped, so this trims the tail
        # instead of rejecting. Node/edge validity is preserved (tail edges go
        # first, then unreferenced tail nodes).
        note_truncated("Display budget reached; publishing a partial graph.")
        edge_targets = {e["source"] for e in edges} | {e["target"] for e in edges}
        while len(edges) > MAX_EDGES:
            edges.pop()
        while len(nodes) > MAX_NODES:
            if nodes[-1]["id"] in edge_targets:
                edges = [e for e in edges if e["source"] != nodes[-1]["id"] and e["target"] != nodes[-1]["id"]]
                edge_targets = {e["source"] for e in edges} | {e["target"] for e in edges}
            nodes.pop()
    try:
        from .rust import RUST_AVAILABLE
    except Exception:
        RUST_AVAILABLE = False
    tier_counts = {}
    for _rel, (_pf, _pname, _lang) in plugin_facts.items():
        tier_counts[_pname] = tier_counts.get(_pname, 0) + 1
    graph = dict(version=1,nodes=nodes,edges=edges,findings=findings,
                 meta=dict(repository=root.name,files=count,files_skipped=skipped_files,
                           truncated=truncated,python_modules=len(facts),
                           rust_modules=len(rust_facts),rust_available=RUST_AVAILABLE,
                           plugin_files=tier_counts,
                           analyzer="polyglot-v1",adapters=[a.name for a in REGISTRY],
                           generic_ontology="Project->Package->Module->Symbol->SourceSpan",
                           cargo_workspace=cargo.get("cargo_workspace", False),
                           cargo_packages=[p["name"] for p in cargo.get("packages", [])],
                           npm_packages=[p["name"] for p in npm_pkgs],
                           go_modules=[p["name"] for p in go_pkgs],
                           tiers="full symbols+calls for python/rust/ts-js/c-cpp/java/kotlin/go (tree-sitter when installed); heuristic defs+imports otherwise; inventory fallback",
                           limitations=["Dynamic dispatch, macros and generated code are not expanded; unresolved calls are explicit externals",
                                        "Partial graphs are marked scan_truncated, never silently cut",
                                        "No repository code was executed"]))
    return validate_graph(graph)


def from_source(source):
    """Local folder or explicitly requested HTTPS clone. No checkout hooks/submodules."""
    if not isinstance(source,str) or len(source)>2048:
        raise ValueError("invalid repository source")
    if source.startswith("https://"):
        parsed = urlparse(source)
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("use an HTTPS repository URL without credentials/query/fragment")
        with tempfile.TemporaryDirectory(prefix="synapsedesk-") as temp:
            target = Path(temp)/"repo"
            env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
            subprocess.run(["git", "-c", "core.hooksPath="+os.devnull, "-c", "protocol.file.allow=never",
                            "-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--no-recurse-submodules",
                            "--", source, str(target)], check=True, timeout=90, env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            graph = analyze(target)
            graph["meta"]["repository"] = parsed.path.rstrip('/').rsplit('/',1)[-1]
            return graph
    if "://" in source:
        raise ValueError("only local paths and HTTPS git URLs are supported")
    return analyze(source)
