"""ElevenLabs speech, called from the service so the key never reaches a browser.

Gated exactly like the agent provider: absent credentials mean a clear refusal, never a silent fallback to
something that merely looks like it worked. `VoiceOff` is the default and it says what is missing.

**This is the one path that sends your voice off the machine.** Everything else here is local by
construction — the analyzer never leaves the disk, the optional reasoner is pinned to 127.0.0.1, and hand
and head tracking are yours. Speech is not: audio goes to ElevenLabs to be transcribed, and replies are
synthesised there. That is a deliberate, opt-in exception and it is written down rather than buried.

stdlib only, like the rest of the service: no SDK, one multipart encoder, urllib for the rest.
"""
import json
import mimetypes
import os
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.elevenlabs.io/v1"
STT_MODEL = "scribe_v1"
TTS_MODEL = "eleven_flash_v2_5"          # the low-latency one; a desk that answers slowly is not a desk
MAX_AUDIO_BYTES = 2_000_000              # about a minute of webm/opus, which is a long thing to say
MAX_SPEAK_CHARS = 800


class VoiceError(Exception):
    pass


class VoiceOff:
    """No credentials: every call refuses and explains itself."""
    name = "off"
    voice_id = ""

    def __init__(self, reason="voice is off: set SYNAPSEDESK_ELEVENLABS_API_KEY and a voice id"):
        self.reason = reason

    def status(self):
        return {"name": self.name, "live": False, "reason": self.reason, "voice_id": ""}

    def transcribe(self, audio, content_type="audio/webm"):
        raise VoiceError(self.reason)

    def speak(self, text):
        raise VoiceError(self.reason)

    def voices(self):
        raise VoiceError(self.reason)


class ElevenLabs:
    name = "elevenlabs"

    def __init__(self, voice_id="", key_env="SYNAPSEDESK_ELEVENLABS_API_KEY", timeout=30,
                 stt_model=STT_MODEL, tts_model=TTS_MODEL):
        self.voice_id = voice_id or ""
        self.key_env = key_env
        self.timeout = timeout
        self.stt_model = stt_model
        self.tts_model = tts_model

    def _key(self):
        key = os.environ.get(self.key_env, "")
        if not key:
            raise VoiceError(f"missing ElevenLabs key in {self.key_env}")
        return key

    def status(self):
        ready = bool(os.environ.get(self.key_env, "")) and bool(self.voice_id)
        reason = ""
        if not os.environ.get(self.key_env, ""):
            reason = f"set {self.key_env}"
        elif not self.voice_id:
            reason = "choose a voice: GET /api/voice/voices lists them"
        return {"name": self.name, "live": ready, "reason": reason, "voice_id": self.voice_id,
                "stt_model": self.stt_model, "tts_model": self.tts_model}

    def _request(self, method, path, data=None, headers=None, limit=6_000_000):
        request = urllib.request.Request(API + path, data, {"xi-api-key": self._key(), **(headers or {})},
                                         method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read(limit + 1)
                if len(body) > limit:
                    raise VoiceError("voice response exceeds budget")
                return response.headers.get("Content-Type", ""), body
        except urllib.error.HTTPError as exc:
            detail = exc.read(400).decode(errors="replace")
            # Never echo the key back, whatever the upstream said.
            raise VoiceError(f"ElevenLabs HTTP {exc.code}: {_scrub(detail)[:240]}")
        except OSError as exc:
            raise VoiceError(f"ElevenLabs unreachable: {str(exc)[:200]}")

    def transcribe(self, audio, content_type="audio/webm"):
        if not audio:
            raise VoiceError("no audio")
        if len(audio) > MAX_AUDIO_BYTES:
            raise VoiceError("audio exceeds the 2 MB budget; speak in shorter turns")
        body, boundary = _multipart({"model_id": self.stt_model},
                                    {"file": ("speech" + _extension(content_type), content_type, audio)})
        _type, raw = self._request("POST", "/speech-to-text", body,
                                   {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        try:
            answer = json.loads(raw)
        except ValueError:
            raise VoiceError("ElevenLabs returned something that is not JSON")
        text = answer.get("text") if isinstance(answer, dict) else None
        if not isinstance(text, str):
            raise VoiceError("no transcript in the ElevenLabs response")
        return {"text": text.strip()[:1000], "language": (answer.get("language_code") or "")[:16]}

    def speak(self, text):
        if not self.voice_id:
            raise VoiceError("choose a voice: GET /api/voice/voices lists them")
        said = (text or "").strip()[:MAX_SPEAK_CHARS]
        if not said:
            raise VoiceError("nothing to say")
        payload = json.dumps({"text": said, "model_id": self.tts_model}, allow_nan=False).encode()
        content_type, raw = self._request(
            "POST", f"/text-to-speech/{urllib.parse.quote(self.voice_id)}?output_format=mp3_44100_128",
            payload, {"Content-Type": "application/json", "Accept": "audio/mpeg"})
        if not raw:
            raise VoiceError("ElevenLabs returned no audio")
        return content_type or "audio/mpeg", raw

    def voices(self):
        _type, raw = self._request("GET", "/voices")
        try:
            answer = json.loads(raw)
        except ValueError:
            raise VoiceError("ElevenLabs returned something that is not JSON")
        out = []
        for voice in (answer.get("voices") or [])[:60]:
            if isinstance(voice, dict) and isinstance(voice.get("voice_id"), str):
                out.append({"voice_id": voice["voice_id"], "name": str(voice.get("name", ""))[:80]})
        return out


def from_config(voice_id="", enabled=True):
    if not enabled:
        return VoiceOff("voice is disabled for this process")
    if not os.environ.get("SYNAPSEDESK_ELEVENLABS_API_KEY", ""):
        return VoiceOff()
    return ElevenLabs(voice_id)


def _extension(content_type):
    guess = mimetypes.guess_extension((content_type or "").split(";")[0].strip() or "audio/webm")
    return guess or ".webm"


def _scrub(text):
    return re.sub(r"[A-Za-z0-9_\-]{24,}", "<redacted>", text or "")


def _multipart(fields, files):
    boundary = "----synapsedesk" + secrets.token_hex(12)
    chunks = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
                      f"{value}\r\n".encode())
    for name, (filename, content_type, blob) in files.items():
        chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; "
                      f"filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n".encode())
        chunks.append(blob)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), boundary
