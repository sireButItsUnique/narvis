"""Replaceable provider adapter. Key stays in env, never in index/responses."""
import json
import os
import time
import urllib.request
import urllib.error


class ProviderError(Exception):
    pass


class StubProvider:
    """Default: live-agent gate explicitly blocked until a credential is supplied."""
    name = "stub"
    def __init__(self, endpoint="", model=""):
        self.endpoint, self.model = endpoint, model
    def test_connection(self):
        raise ProviderError("live-agent gate blocked: no model endpoint/credential configured")
    def complete(self, messages, timeout=30, retries=1):
        raise ProviderError("live-agent gate blocked: configure Chat Completions endpoint + model + API key")


class ChatCompletionsProvider:
    """Server-side Chat Completions-compatible endpoint. Key from env only."""
    name = "chat-completions"
    def __init__(self, endpoint, model, key_env="SYNAPSEDESK_API_KEY", timeout=30, retries=2):
        if not endpoint or not model:
            raise ProviderError("endpoint and model are required")
        self.endpoint = endpoint.rstrip("/")
        self.model = model
        self.key_env = key_env
        self.timeout = timeout
        self.retries = retries
    def _key(self):
        # Accept the historical SYNASEDESK_ spelling so existing setups keep working.
        key = os.environ.get(self.key_env, "") or os.environ.get(self.key_env.replace("SYNAPSE", "SYNASE"), "")
        if not key:
            raise ProviderError(f"missing API key in {self.key_env}")
        return key
    def _post(self, payload):
        key = self._key()
        data = json.dumps(payload, allow_nan=False).encode()
        last = None
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(self.endpoint + "/chat/completions", data,
                {"Content-Type": "application/json", "Authorization": "Bearer " + key})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    body = r.read(512001)
                if len(body) > 512000:
                    raise ProviderError("model response exceeds budget")
                return json.loads(body)
            except urllib.error.HTTPError as e:
                last = ProviderError(f"provider HTTP {e.code}: {e.read(500).decode(errors='replace')[:300]}")
            except (OSError, ValueError) as e:
                last = ProviderError(f"provider {type(e).__name__}: {str(e)[:300]}")
            time.sleep(min(2 ** attempt, 4))
        raise last
    def test_connection(self):
        # Minimal non-streaming probe; explicit errors, no key in output.
        out = self._post({"model": self.model, "messages": [{"role": "user", "content": "ok"}], "max_tokens": 1})
        if not isinstance(out, dict) or "choices" not in out:
            raise ProviderError("invalid provider response")
        return {"ok": True, "model": self.model, "endpoint": self.endpoint}
    def complete(self, messages, timeout=None, retries=None):
        out = self._post({"model": self.model, "messages": messages, "temperature": 0})
        try:
            return out["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise ProviderError("invalid provider response")


def from_config(endpoint="", model=""):
    if endpoint and model:
        return ChatCompletionsProvider(endpoint, model)
    return StubProvider(endpoint, model)
