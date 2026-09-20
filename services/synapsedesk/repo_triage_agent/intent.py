"""What a spoken sentence means, resolved against the graph that is actually loaded.

Same split as the analyzer itself. A grammar handles the things people actually say to a workbench, with
no model call and no possibility of invention. Anything it does not recognise may go to the provider, which
must answer in a fixed shape that is then checked against the real graph: an intent naming a node that does
not exist is refused, exactly as a model review citing a nonexistent finding is refused in reasoner.py.

The verbs are bounded and they are not equal. Navigating, explaining and searching only read, so they run.
Implementing writes into a working copy and runs that repository's test command, so it is only ever
PROPOSED: the spoken loop cannot start it. Something has to say yes, and a microphone is not a good enough
witness for that.
"""
import re

READ_ONLY = ("navigate", "ascend", "root", "explain", "search", "zoom", "describe", "tasks")
ACTING = ("implement", "cancel")
VERBS = READ_ONLY + ACTING

STOPWORDS = {"the", "a", "an", "to", "into", "in", "on", "at", "of", "for", "me", "my", "please",
             "folder", "file", "module", "function", "class", "directory", "dir", "up", "back"}

# Spoken forms, most specific first: "go up" must not be read as "go to up".
PATTERNS = [
    (r"^(?:go\s+)?(?:back|up|out)(?:\s+(?:a\s+)?level)?$", "ascend", None),
    (r"^(?:(?:go|take\s+me|back)\s+)?(?:to\s+)?(?:the\s+)?"
     r"(?:home|top|root|system|start|beginning|all\s+the\s+way\s+(?:up|back|out))$", "root", None),
    (r"^(?:zoom|scale)\s+(in|out)$", "zoom", "direction"),
    (r"^(?:zoom\s+to\s+)?fit$|^fit\s+(?:it\s+)?(?:on\s+screen|to\s+(?:the\s+)?(?:screen|desk))$", "zoom", "fit"),
    (r"^(?:what(?:'s| is| are)?(?: this| that| these| here)?|describe(?: this| that| it| here)?|"
     r"where am i|what am i looking at)\??$", "describe", None),
    (r"^(?:explain|tell me about|what does)\s+(.+?)(?:\s+do)?\??$", "explain", "target"),
    (r"^(?:explain|explain this|explain it)\??$", "explain", None),
    (r"^(?:find|search(?:\s+for)?|where(?:'s| is)|look for|show me all)\s+(.+?)\??$", "search", "text"),
    (r"^(?:open|go\s+to|enter|show(?:\s+me)?|take me (?:to|into)|jump to|dive into)\s+(.+?)\??$",
     "navigate", "target"),
    (r"^(?:list\s+)?tasks?$|^what(?:'s| is) running\??$", "tasks", None),
    (r"^(?:cancel|stop|abort)(?:\s+(?:the\s+)?task)?$", "cancel", None),
    (r"^(?:implement|change|fix|refactor|rename|add|remove|write|make)\s+(.+?)\??$", "implement", "text"),
]


def normalise(utterance):
    text = (utterance or "").strip().lower()
    text = re.sub(r"[^\w\s/.:'-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _tokens(text):
    return [t for t in re.split(r"[\s/._-]+", text) if t and t not in STOPWORDS]


def score(query, node, path):
    """How well a spoken phrase names this node. 0 means no."""
    want = _tokens(query)
    if not want:
        return 0.0
    label = (node.get("label") or "").lower()
    # A module's label IS its full path, so the coverage penalty below would punish anything nested:
    # "volume hands" covers two of the six words in laptop_hand_tracking/volume_hands.py and loses to a
    # method that merely contains "volume". The basename is what a person actually says.
    basename = label.rsplit("/", 1)[-1]
    # A symbol is matched by ITS OWN name only. Letting it inherit its file's path as a haystack made
    # every function in contracts.py score nearly as well as contracts.py itself, so "open contracts"
    # came back as a question. You name a thing by its name; you name a file or a folder by its path.
    container = node.get("kind") in ("module", "folder") or bool(node.get("directory"))
    haystacks = [basename, label]
    if container:
        haystacks += [(path or "").lower().rsplit("/", 1)[-1], (path or "").lower()]
    best = 0.0
    for hay in haystacks:
        have = _tokens(hay)
        if not have:
            continue
        if hay == query or label.rstrip("/") == query:
            return 1.0
        hit = sum(1 for w in want if any(w == h for h in have))
        # BOTH sides of a partial match must be substantial. Guarding only the spoken word let a node
        # labelled "k" near-match "pack", and "explain pack level" answered "which one: k, e, e?".
        near = sum(1 for w in want
                   if any(w != h and len(w) > 2 and len(h) > 2 and (w in h or h in w) for h in have))
        if not hit and not near:
            continue
        # Whole-word matches count fully, partials a third.
        value = (hit + near / 3) / len(want)
        # And the candidate is penalised for words the speaker did NOT say. Without this, "store" scores
        # the same against `Store` and against `Store.latest`, every method of a class ties with the class
        # itself, and a perfectly clear instruction comes back as "which one?".
        value *= len(want) / max(len(want), len(have))
        value *= 1.0 if hay in (label, basename) else 0.85
        best = max(best, min(1.0, value))
    return best


def directories(paths):
    """The folders the desk actually shows, derived from module paths.

    The graph has no folder nodes — the levels build them — so without this, "open the triage agent" can
    only match files inside `repo_triage_agent/` and comes back ambiguous, when the folder is plainly what
    was meant.
    """
    seen = {}
    for path in paths.values():
        parts = [p for p in (path or "").split("/") if p][:-1]
        for depth in range(len(parts)):
            key = "/".join(parts[:depth + 1])
            seen.setdefault(key, dict(id="dir:" + key, label=parts[depth] + "/", kind="folder",
                                      directory=key))
    return list(seen.values())


def resolve(query, nodes, paths, limit=4):
    """Rank the indexed nodes a phrase might mean. Never invents one."""
    scored = []
    for node in nodes:
        value = score(query, node, node.get("directory") or paths.get(node.get("id"), ""))
        if value > 0:
            scored.append((value, node))
    scored.sort(key=lambda pair: (-pair[0], len(pair[1].get("label") or "")))
    return [dict(node=node, score=round(value, 3)) for value, node in scored[:limit]]


def parse(utterance):
    """The grammar. Returns a verb and its raw argument, or None if nothing matched."""
    text = normalise(utterance)
    if not text:
        return None
    for pattern, verb, slot in PATTERNS:
        match = re.match(pattern, text)
        if not match:
            continue
        argument = ""
        if slot and match.groups():
            argument = (match.group(1) or "").strip()
        if slot and not argument and slot in ("target", "text"):
            continue          # "open" with nothing to open is not an instruction
        return dict(verb=verb, slot=slot, argument=argument, source="grammar", utterance=utterance)
    return None


SCHEMA = {"type": "object", "properties": {
    "verb": {"type": "string", "enum": list(VERBS)},
    "argument": {"type": "string"},
    "say": {"type": "string"}},
    "required": ["verb", "argument", "say"], "additionalProperties": False}


def validate_model_intent(value):
    """A provider's answer, before it is allowed anywhere near the desk."""
    if not isinstance(value, dict):
        raise ValueError("intent must be an object")
    verb = value.get("verb")
    if verb not in VERBS:
        raise ValueError(f"unknown verb: {verb!r}")
    argument = value.get("argument", "")
    if not isinstance(argument, str) or len(argument) > 400:
        raise ValueError("invalid intent argument")
    say = value.get("say", "")
    if not isinstance(say, str) or len(say) > 600:
        raise ValueError("invalid spoken reply")
    return dict(verb=verb, argument=argument.strip(), say=say.strip(), source="model")


SYSTEM_PROMPT = (
    "You turn one spoken sentence into a single action on a code workbench. "
    "Answer with JSON only: {\"verb\": ..., \"argument\": ..., \"say\": ...}. "
    f"verb is one of: {', '.join(VERBS)}. "
    "argument is the thing the verb acts on, in the user's own words; empty when the verb needs none. "
    "say is one short sentence to read aloud, under twenty words. "
    "The workbench shows an indexed graph of a real repository. You cannot see the code and you must not "
    "describe it: naming a file, function or behaviour you were not given is the one unacceptable answer. "
    "If the sentence does not clearly map to a verb, use verb 'describe' and say that you did not catch it."
)
