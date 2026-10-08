"""Server-only provider selection for the reversible university demo."""
from dataclasses import dataclass
import json
import os
from urllib.parse import urlparse

import httpx


DEMO_ERROR = "Demo AI is unavailable right now. Please wait a moment and try again. No paid fallback was used."


@dataclass(frozen=True)
class ProviderConfig:
    demo: bool
    provider: str
    api_key: str
    base_url: str
    text_model: str
    stt_model: str

    @classmethod
    def from_env(cls):
        demo = os.getenv("ALEX_DEMO_FREE_MODE", "false").lower().strip() in ("true", "1", "yes")
        provider = "groq" if demo else os.getenv("ALEX_TEXT_PROVIDER", "openrouter").lower().strip()
        if provider not in ("groq", "openrouter"):
            raise ValueError("ALEX_TEXT_PROVIDER must be groq or openrouter")
        base = (os.getenv("GROQ_BASE_URL") or "https://api.groq.com/openai/v1").strip().rstrip("/")
        # A demo configuration must not accidentally send the key to another provider.
        parsed = urlparse(base)
        if demo and (parsed.scheme != "https" or parsed.netloc != "api.groq.com" or parsed.path != "/openai/v1"):
            raise ValueError("Free demo mode requires https://api.groq.com/openai/v1")
        return cls(demo, provider, os.getenv("GROQ_API_KEY", "").strip(), base,
                   (os.getenv("GROQ_TEXT_MODEL") or "openai/gpt-oss-20b").strip(),
                   (os.getenv("GROQ_STT_MODEL") or "whisper-large-v3-turbo").strip())

    @property
    def uses_groq(self):
        return self.provider == "groq"

    @property
    def blocks_paid(self):
        return self.demo

    def headers(self):
        if not self.api_key:
            raise RuntimeError("Demo AI is not configured. Ask the organizer to set GROQ_API_KEY on the server.")
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}


CONFIG = ProviderConfig.from_env()
GROQ_TIMEOUT = httpx.Timeout(35.0, connect=5.0)


def text_payload(config, messages, max_tokens, temperature=None, *, stream=False):
    payload = {"model": config.text_model, "messages": messages,
               "max_tokens": min(max_tokens, 2048) if config.demo else max_tokens}
    if temperature is not None:
        payload["temperature"] = temperature
    if stream:
        payload["stream"] = True
    return payload


def complete(config, messages, max_tokens=2048, temperature=None):
    with httpx.Client(timeout=GROQ_TIMEOUT) as client:
        response = client.post(config.base_url + "/chat/completions", headers=config.headers(),
                               json=text_payload(config, messages, max_tokens, temperature))
        response.raise_for_status()
        content = response.json()["choices"][0]["message"].get("content") or ""
        if not content.strip():
            raise RuntimeError("Provider returned an empty reply")
        return content


async def stream(config, messages, max_tokens=2048):
    received_content = False
    completed = False
    async with httpx.AsyncClient(timeout=GROQ_TIMEOUT) as client:
        async with client.stream("POST", config.base_url + "/chat/completions",
                                 headers=config.headers(),
                                 json=text_payload(config, messages, max_tokens, stream=True)) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    completed = True
                    break
                chunk = json.loads(data)
                if chunk.get("error"):
                    raise RuntimeError("Provider stream failed")
                choices = chunk.get("choices") or []
                if choices:
                    content = choices[0].get("delta", {}).get("content")
                    if content:
                        received_content = True
                        yield content
            if not completed or not received_content:
                raise RuntimeError("Provider stream was empty or interrupted")


def audio_upload(content_type):
    mime = (content_type or "audio/webm").split(";", 1)[0].strip().lower()
    extensions = {"audio/webm": "webm", "video/webm": "webm", "audio/mp4": "m4a",
                  "video/mp4": "mp4", "audio/ogg": "ogg", "audio/wav": "wav",
                  "audio/x-wav": "wav", "audio/mpeg": "mp3"}
    if mime not in extensions:
        raise ValueError("Unsupported microphone audio format. Please try another browser.")
    return "audio." + extensions[mime], mime


async def transcribe(config, audio, content_type):
    filename, mime = audio_upload(content_type)
    headers = config.headers()
    headers.pop("Content-Type")  # httpx must supply the multipart boundary.
    async with httpx.AsyncClient(timeout=GROQ_TIMEOUT) as client:
        response = await client.post(config.base_url + "/audio/transcriptions", headers=headers,
                                     files={"file": (filename, audio, mime)},
                                     data={"model": config.stt_model, "response_format": "json"})
        response.raise_for_status()
        return (response.json().get("text") or "").strip()
