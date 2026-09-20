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


# The physical rig, in the units the person measuring it actually uses. Everything about the hologram
# scales off the panel diagonal: rig/rigtest2/README.md warns that entering a 27 inch panel as 24 puts the
# image about 12% out and no trimming fixes it, so it is a first-class field rather than a constant.
#
# Defaults describe the built rig: a 27" 16:9 panel and a 16:9 acrylic sheet. The sheet is taken as
# 24 x 13.5 in — the 16:9 rectangle keeping the 24 inch long edge of the 18 x 24 sheet, because an 18 inch
# long edge (45.7 cm) could not catch a 59.8 cm wide panel at all. CONFIRM THAT before trusting the scale.
#
# The monitor pose is not a free choice with this sheet. A 16:9 sheet is 13.5 in deep where the old 4:3 one
# was 18, and at a 6 in drop two of the four image corners reflect off the back edge at every tilt tried.
# A 24 cm drop clears it; 40 degrees is the tilt that then leaves the largest image. tests/volume.test.mjs
# asserts the vendored rigCheck raises no warnings for these numbers, so a bad pose cannot ship silently.
DEFAULT_RIG = dict(version=1, panel_diagonal_in=27.0, panel_aspect_w=16.0, panel_aspect_h=9.0,
                   sheet_width_cm=60.96, sheet_depth_cm=34.29, sheet_thickness_mm=2.03,
                   monitor_drop_cm=24.0, monitor_forward_cm=-18.0, base_drop_cm=15.24,
                   tilt_deg=40.0, anchor_drop_cm=13.0)

# Derived from the rig above, not chosen: the largest slab carrying 10 cm of depth whose every corner
# still lands on the panel. The 16:9 sheet costs real image — a 4:3 sheet of the same width allowed
# 37 x 20.8 cm here, this allows 21.1 x 11.9.
DEFAULT_VOLUME = dict(version=1, width_cm=21.1, depth_cm=10.0, height_cm=11.9)


def validate_rig(rig):
    """Physical measurements of the rig. The service stores them; the client does the optics."""
    if not isinstance(rig, dict) or rig.get("version") != 1:
        raise ValueError("rig.version must be 1")
    out = dict(version=1)
    limits = dict(panel_diagonal_in=(5, 120), panel_aspect_w=(1, 100), panel_aspect_h=(1, 100),
                  sheet_width_cm=(5, 300), sheet_depth_cm=(5, 300), sheet_thickness_mm=(0.1, 50),
                  monitor_drop_cm=(1, 200), monitor_forward_cm=(-200, 200), base_drop_cm=(0, 200),
                  tilt_deg=(-89, 89), anchor_drop_cm=(0.5, 100))
    for key, (lo, hi) in limits.items():
        value = rig.get(key, DEFAULT_RIG[key])
        if not number(value, lo, hi):
            raise ValueError(f"{key} must be between {lo} and {hi}")
        out[key] = float(value)
    return out


def validate_volume(volume):
    """The working volume in centimetres. The service carries it; clients map into it."""
    if not isinstance(volume, dict) or volume.get("version") != 1:
        raise ValueError("volume.version must be 1")
    out = dict(version=1)
    for axis in ("width_cm", "depth_cm", "height_cm"):
        value = volume.get(axis)
        if not number(value, 1, 500):
            raise ValueError(f"{axis} must be between 1 and 500 centimetres")
        out[axis] = float(value)
    return out


def validate_eye(packet):
    """Head position from a stereo tracker, already in RIG centimetres.

    The service does not solve heads: the tracker owns the cameras, the baseline and the fit, exactly as
    the depth adapter owns its registration. Raw camera-space input is refused, not guessed at.
    """
    if not isinstance(packet, dict) or packet.get("version") != 1:
        raise ValueError("eye.version must be 1")
    if packet.get("frame") != "rig_cm":
        raise ValueError("head position must already be registered to rig_cm")
    point = packet.get("position_cm")
    if not isinstance(point, list) or len(point) != 3 or not all(number(v, -300, 300) for v in point):
        raise ValueError("position_cm must be three finite centimetre values")
    if not number(packet.get("age_ms"), 0, 10000):
        raise ValueError("invalid head frame age")
    if type(packet.get("simulated")) is not bool:
        raise ValueError("simulated must be a boolean")
    return dict(version=1, frame="rig_cm", position_cm=[float(v) for v in point],
                age_ms=float(packet["age_ms"]), simulated=packet["simulated"])


HAND_LABELS = ("left", "right", "unknown")
UNITS_CM = {"cm": 1.0, "m": 100.0, "mm": 0.1, "in": 2.54}
AXES = ("x", "y", "z", "-x", "-y", "-z")

# How a tracker's own coordinates become rig centimetres. Set once, then the tracker posts its raw numbers
# forever: axes reorders and flips them, scale and offset are applied after the unit conversion. The
# identity below means "already rig centimetres".
DEFAULT_HAND_FRAME = dict(version=1, units="cm", axes=["x", "y", "z"],
                          scale=[1.0, 1.0, 1.0], offset=[0.0, 0.0, 0.0])


def validate_hand_frame(frame):
    if not isinstance(frame, dict) or frame.get("version") != 1:
        raise ValueError("hand_frame.version must be 1")
    units = frame.get("units", "cm")
    if units not in UNITS_CM:
        raise ValueError(f"units must be one of {', '.join(sorted(UNITS_CM))}")
    axes = frame.get("axes", ["x", "y", "z"])
    if not isinstance(axes, list) or len(axes) != 3 or any(a not in AXES for a in axes):
        raise ValueError("axes must be three of x, y, z, -x, -y, -z")
    if len({a.lstrip("-") for a in axes}) != 3:
        raise ValueError("axes must use each of x, y and z exactly once")
    out = dict(version=1, units=units, axes=list(axes))
    for key, lo, hi in (("scale", 0.01, 100.0), ("offset", -500.0, 500.0)):
        value = frame.get(key, DEFAULT_HAND_FRAME[key])
        if not isinstance(value, list) or len(value) != 3 or not all(number(v, lo, hi) for v in value):
            raise ValueError(f"{key} must be three numbers between {lo} and {hi}")
        out[key] = [float(v) for v in value]
    return out


def register_point(point, frame):
    """One tracker point -> rig centimetres, using the stored frame."""
    unit = UNITS_CM[frame["units"]]
    index = {"x": 0, "y": 1, "z": 2}
    out = []
    for i, axis in enumerate(frame["axes"]):
        sign = -1.0 if axis.startswith("-") else 1.0
        out.append(sign * point[index[axis.lstrip("-")]] * unit * frame["scale"][i] + frame["offset"][i])
    return out


def validate_hands(packet, frame=None):
    """Hands from a tracker, mapped into RIG centimetres by the stored hand frame.

    Deliberately forgiving about shape, because the tracker already exists and should not be rewritten to
    suit this service: send the 21 MediaPipe landmarks if you have them, or just the two fingertips that
    a pinch actually needs. Pinch itself is NOT accepted from upstream — the service derives it, so one
    tracker's idea of "pinching" cannot silently change what the desk does.
    """
    frame = frame or DEFAULT_HAND_FRAME
    if not isinstance(packet, dict) or packet.get("version") != 1:
        raise ValueError("hands.version must be 1")
    if not number(packet.get("age_ms"), 0, 10000):
        raise ValueError("invalid hand frame age")
    simulated = packet.get("simulated", False)
    if type(simulated) is not bool:
        raise ValueError("simulated must be a boolean")
    hands = packet.get("hands")
    if not isinstance(hands, list) or len(hands) > 2:
        raise ValueError("at most two hands")
    out = []
    for hand in hands:
        if not isinstance(hand, dict):
            raise ValueError("invalid hand")
        label = hand.get("label", "unknown")
        if label not in HAND_LABELS:
            raise ValueError("hand label must be left, right or unknown")
        points = hand.get("landmarks") or hand.get("landmarks_cm")
        if points is None and hand.get("index_tip") is not None:
            # The minimal form: the two points a pinch is made of. The rest of the hand is drawn from
            # them only so there is something to see; no joint position is claimed.
            thumb, index = hand.get("thumb_tip"), hand.get("index_tip")
            for p in (thumb, index):
                if not isinstance(p, list) or len(p) != 3 or not all(number(v, -100000, 100000) for v in p):
                    raise ValueError("thumb_tip and index_tip must each be three finite numbers")
            points = [index] * 21
            points[4], points[8] = thumb, index
        if not isinstance(points, list) or len(points) != 21:
            raise ValueError("send 21 landmarks in MediaPipe order, or thumb_tip and index_tip")
        registered = []
        for point in points:
            if not isinstance(point, list) or len(point) != 3 or not all(number(v, -100000, 100000) for v in point):
                raise ValueError("invalid hand landmark")
            mapped = register_point(point, frame)
            if not all(math.isfinite(v) and -300 <= v <= 300 for v in mapped):
                raise ValueError("landmark lands outside the desk once registered; check the hand frame")
            registered.append(mapped)
        out.append(dict(label=label, landmarks_cm=registered))
    return dict(version=1, frame="rig_cm", age_ms=float(packet["age_ms"]),
                simulated=simulated, hands=out)


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
