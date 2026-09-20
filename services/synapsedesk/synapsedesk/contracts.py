"""Bounded, versioned inputs shared by the service, agent, and camera worker."""
import math
import re

MAX_NODES = 600
MAX_EDGES = 3000
ID = re.compile(r"^[a-zA-Z0-9_.:/@#-]{1,240}$")


def number(value, lo=-10, hi=10):
    return type(value) in (int, float) and math.isfinite(value) and lo <= value <= hi


def validate_graph(graph):
    if not isinstance(graph, dict) or graph.get("version") != 1:
        raise ValueError("graph.version must be 1")
    nodes, edges = graph.get("nodes"), graph.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValueError("nodes and edges must be lists")
    if len(nodes) > MAX_NODES or len(edges) > MAX_EDGES:
        raise ValueError("graph exceeds capacity; analyze a smaller repository")
    ids = set()
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str) or not ID.fullmatch(node["id"]):
            raise ValueError("invalid node id")
        if node["id"] in ids:
            raise ValueError("duplicate node id")
        ids.add(node["id"])
        if node.get("kind") not in ("module", "function", "class", "external"):
            raise ValueError("invalid node kind")
        if not isinstance(node.get("label"), str) or len(node["label"]) > 240:
            raise ValueError("invalid node label")
        evidence = node.get("evidence", {})
        if not isinstance(evidence, dict) or not isinstance(evidence.get("path", ""), str):
            raise ValueError("invalid node evidence")
    edge_ids = set()
    for edge in edges:
        if not isinstance(edge, dict) or edge.get("source") not in ids or edge.get("target") not in ids:
            raise ValueError("dangling edge")
        if not isinstance(edge.get("id"), str) or not ID.fullmatch(edge["id"]) or edge["id"] in edge_ids:
            raise ValueError("invalid or duplicate edge id")
        edge_ids.add(edge["id"])
        if edge.get("kind") not in ("contains", "imports", "calls", "proposed"):
            raise ValueError("invalid edge kind")
    findings = graph.get("findings", [])
    if not isinstance(findings, list) or len(findings) > 2000:
        raise ValueError("invalid findings")
    return graph


def validate_tracking(packet):
    if not isinstance(packet, dict) or packet.get("version") != 1:
        raise ValueError("tracking.version must be 1")
    if not isinstance(packet.get("stream"), str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,64}", packet["stream"]):
        raise ValueError("invalid stream")
    if type(packet.get("seq")) is not int or not 0 < packet["seq"] < 2**53:
        raise ValueError("invalid sequence")
    if not number(packet.get("age_ms"), 0, 10000):
        raise ValueError("invalid frame age")
    if not number(packet.get("aspect"), .2, 5):
        raise ValueError("invalid camera aspect ratio")
    if type(packet.get("present")) is not bool or type(packet.get("simulated")) is not bool:
        raise ValueError("present and simulated must be booleans")
    points = packet.get("landmarks")
    if not isinstance(points, list) or len(points) != (21 if packet["present"] else 0):
        raise ValueError("expected 21 landmarks for a present hand")
    for point in points:
        if not isinstance(point, list) or len(point) != 3 or not all(number(v) for v in point):
            raise ValueError("invalid landmark")
    return packet


def validate_view(trail):
    """A drill-down path: directories, then a file, then a symbol id. At most 8 deep."""
    if not isinstance(trail, list) or len(trail) > 8:
        raise ValueError("view trail must be a list of at most 8 entries")
    for entry in trail:
        if not isinstance(entry, str) or not 0 < len(entry) <= 300 or "\x00" in entry:
            raise ValueError("invalid view trail entry")
    return list(trail)


def validate_bounds(bounds):
    if not isinstance(bounds, dict) or set(bounds) != {"xmin", "xmax", "ymin", "ymax"}:
        raise ValueError("bounds require xmin, xmax, ymin, ymax")
    if not all(number(v, 0, 1) for v in bounds.values()):
        raise ValueError("bounds must be finite normalized coordinates")
    if bounds["xmax"] - bounds["xmin"] < .05 or bounds["ymax"] - bounds["ymin"] < .05:
        raise ValueError("interaction rectangle is empty or too small")
    return dict(bounds)
